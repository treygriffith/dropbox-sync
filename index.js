var Dropbox = require('dropbox')
  , merge = require('merge')
  , fs = require('fs-extra')
  , async = require('async')
  , Path = require('path')
  , debug = require('debug')('DropboxSync')
  , clone = require('clone');

module.exports = DropboxSync;

/**
 * Create a new DropboxSync instance
 * @param {Object} dropboxConfig 
 * @param dropboxConfig {String} key Dropbox API key
 * @param dropboxConfig {String} secret Dropbox API secret
 * @param dropboxConfig {String} uid User's Dropbox UID
 * @param dropboxConfig {String} token User's OAuth Access token
 * @param {String} root Local path for the user's dropbox
 */
function DropboxSync(dropboxConfig, root) {
  if(cache[dropboxConfig.uid]) {
    return cache[dropboxConfig.uid];
  } else {
    cache[dropboxConfig.uid] = this;
  }

  this.client = new Dropbox.Client({
    key: dropboxConfig.key,
    secret: dropboxConfig.secret,
    uid: dropboxConfig.uid,
    token: dropboxConfig.token
  });

  this.root = root;
  this.paths = {};

  this.cursor = null;

  this.watchingForChanges = null;
}

var cache = {};

// convenience method
/**
 * Convenience function for keeping a folder in sync
 * @param  {Object} options  Dropbox Configuration. See DropboxSync
 * @param  {String} localPath local path for the user's dropbox
 * @param  {String} syncPath     Folder within the dropbox to limit the sync to (if any)
 * @param  {function(Error)} onError  Evaluated when an error occurs. If triggered, DropboxSync will not continue to attempt to keep the folder in sync.
 * @param  {function(Array)} onChange Evaluated every time a change occurs in the dropbox with an array of the modified paths.
 * @return {DropboxSync}          The DropboxSync instance generated
 */
DropboxSync.sync = function (options, localPath, syncPath, onError, onChange) {
  var dbfs = new DropboxSync(options, localPath);

  dbfs.sync(syncPath, onError, onChange);

  return dbfs;
};

/**
 * Sync a specific folder to the local path
 * @param  {String} path Folder within dropbox to monitor
 * @param  {function(error)} onError  Evaluated when an error occurs. If triggered, this instance will not continue to sync.
 * @param  {function(Array)} onChange Evaluated every time a change occurs in the dropbox with an array of the modified paths.
 * @return {DropboxSync}
 */
DropboxSync.prototype.sync = function (path, onError, onChange) {
  var self = this;

  path = normalizePath(path);

  this.paths[path] = function (err, changesMade) {
    if(err) return onError(err);

    if(changesMade.changes.length) {
      // trigger the onChange
      onChange(changesMade.changes.map(function (change) {
        return self.toLocalPath(change.path);
      }));
    }

    self.watchForChanges();

  };

  this.watchForChanges();

  return this;
};

/**
 * Stop syncing a specific folder to the local path
 * @param  {String} path Folder within dropbox to monitor
 * @param  {function(error)} callback  Evaluated after syncing has stopped.
 * @return {DropboxSync}
 */
DropboxSync.prototype.stopSync = function (path, callback) {

  path = normalizePath(path);

  delete this.paths[path];

  // no paths left to watch for, kill our longpoll
  if(!Object.keys(this.paths).length) {

    debug('aborting outstanding XHR');
    this.watchingForChanges.abort();

    this.watchingForChanges = null;
  }

  debug('resetting '+path);

  this.resetDir(path, callback);
};

/**
 * Watch for changes in a Dropbox folder, and commit them when they occur
 * @return {DropboxSync}
 */
DropboxSync.prototype.watchForChanges = function () {
  var self = this;

  if(!this.cursor) {
    return this.pullChanges();
  }

  if(this.watchingForChanges) return this;

  debug('watching for changes...');

  this.watchingForChanges = this.client.pollForChanges(this.cursor, function (err, pollResult) {
    if(err) return self.errAll(err);

    debug('watch for changes returned.');

    if(!self.watchingForChanges) {
      debug('no longer watching for changes, returning.');
      return;
    }

    // reset watching for changes status
    self.watchingForChanges = null;

    if(!pollResult.hasChanges) {

      debug('No changes reported. Polling again in ' + ((pollResult.retryAfter || 0) * 1000) + ' seconds.');

      delay(pollResult.retryAfter, function () {

        self.watchForChanges();
      });

    } else {

      debug('changes reported, processing...');

      self.pullChanges();
    }

  });

  return this;
};

/**
 * Pull changes from a dropbox for a particular path
 * @param  {Dropbox.Http.PulledChanges} prevChanges The result of the last pullChanges call - used internally by pullChanges.
 * @return {DropboxSync}
 */
DropboxSync.prototype.pullChanges = function (prevChanges) {
  var self = this;

  if(this.pullingChanges) return;

  this.pullingChanges = true;

  debug('pulling changes...');

  this.client.pullChanges(this.cursor, function (err, pulledChanges) {
    if(err) return self.errAll(err);

    self.cursor = pulledChanges;

    self.pullingChanges = false;

    debug(pulledChanges.changes.length + ' changes reported.');

    if(prevChanges) {
      // handle multiple pulls
      prevChanges.changes = prevChanges.changes.concat(pulledChanges.changes);
    }

    if(pulledChanges.shouldPullAgain) {
      debug('more changes to pull, pulling...');
      return self.pullChanges(prevChanges || pulledChanges);
    }

    pulledChanges = prevChanges || pulledChanges;

    // filter changes by path that we're watching
    var changedPaths = [];

    Object.keys(self.paths).forEach(function (path) {

      var filtered = pulledChanges.changes.filter(function (change) {
        return change.path.slice(0, path.length) === path;
      });

      debug(filtered.length + ' changes remaining after filtering for '+path+'.');

      if(filtered.length) {
        var clonedChanges = clone(pulledChanges);
        var callback = self.paths[path];
        clonedChanges.changes = filtered;

        changedPaths.push(path);

        // commit changes relevant to this path
        self.commitChanges(path, clonedChanges, callback);
      }
    });

    // none of our paths were changed, so we need to reset it here
    if(!changedPaths.length) {
      self.watchForChanges();
    }
  }); 

  return this;
};

/**
 * Reset the local path to an empty state
 * @param  {String} path Path within the dropbox to reset
 * @param  {Function} callback Evaluated with (err, firstDirectoryMade) on completion
 * @return {DropboxSync}
 */
DropboxSync.prototype.resetDir = function(path, callback) {
  // slice off the leading slash from path
  var dir = Path.resolve(this.root, path.slice(1));

  debug('resetting root directory: '+dir);

  fs.remove(dir, function (err) {
    if(err) return callback(err);

    fs.mkdirs(dir, callback);
  });

  return this;
};

/**
 * Send an error to all the callbacks
 * @param  {Error} err Error encountered that affects all paths.
 * @return {[type]}     [description]
 */
DropboxSync.prototype.errAll = function (err) {
  var paths = this.paths;
  Object.keys(paths).forEach(function (path) {
    paths[path](err);
  });
};

/**
 * Translate a dropbox path to a local path
 * @param  {String} path Path within dropbox
 * @return {String}      Local path equivalent
 */
DropboxSync.prototype.toLocalPath = function (path) {
  if(path[0] === '/') {
    path = '.' + path;
  }
  return Path.join(this.root, path);
};

/**
 * Commit the pulled changes to the local state
 * @param  {String}   path          Path from which changes are pulled
 * @param  {Dropbox.Http.PulledChanges}   pulledChanges Changes that need to be commited to the local state
 * @param  {Function} callback      Evaluated with (err, Dropbox.Http.PulledChanges) on completion
 * @return {DropboxSync}
 */
DropboxSync.prototype.commitChanges = function(path, pulledChanges, callback) {
  var self = this;

  debug('commiting '+pulledChanges.changes.length+' changes.');
  
  async.series([

    // reset directory
    function (next) {
      if(pulledChanges.blankSlate) {
        self.resetDir(path, next);
      } else {
        next();
      }
    },

    // make filesystem updates
    function (next) {
      async.each(pulledChanges.changes, self.commitChange.bind(self), next);
    }

  ], function (err) {

    if(err) return callback(err);

    callback(null, pulledChanges);
  });

  return this;
};

/**
 * Commit a single change to the local filesystem.
 * See https://www.dropbox.com/developers/core/docs#delta
 * 
 * @param  {Dropbox.Http.PulledChange}   change   Dropbox change to be commited
 * @param  {Function} callback Evaluated with (err, somethingRandom)
 * @return {DropboxSync}
 */
DropboxSync.prototype.commitChange = function (change, callback) {

  if(change.wasRemoved) {
    debug(change.path + " was deleted.");

    // delete file or folder
    fs.remove(this.toLocalPath(change.path), callback);

  } else if(change.stat.isFile) {
    debug(change.path + " is now a file.");

    this._replaceLocalWithFile(change, callback);

  } else if(change.stat.isFolder) {
    debug(change.path + " is now a folder.");

    this._replaceLocalWithFolder(change, callback);

  } else {

    // not sure what would fall in here
    callback(new Error("Unable to commit change."));
  }

  return this;
};

/**
 * Replace a local path with a file from dropbox
 * @api private
 * @param  {Dropbox.Http.PulledChange}   change   Dropbox change that requires a file at the path
 * @param  {Function} callback Evaluated with (err) on completion
 * @return {null}
 */
DropboxSync.prototype._replaceLocalWithFile = function (change, callback) {

  var self = this
    , localPath = this.toLocalPath(change.path);

  async.parallel({

    // remove local state
    local: function (next) {
      fs.remove(localPath, next);
    },

    // fetch dropbox entry
    dropbox: function (next) {
      self.client.readFile(change.path, { buffer: true }, function (err, buffer, stat) {
        next(err, buffer);
      });
    }
  }, function (err, results) {
    if(err) return callback(err);

    // add dropbox entry to local state
    fs.outputFile(localPath, results.dropbox, callback);
  });
};

/**
 * Replace a local path with a folder from dropbox
 * @api private
 * @param  {Dropbox.Http.PulledChange}   change   Dropbox change that requires a file at the path
 * @param  {Function} callback Evaluated with (err, firstFolderMade) on completion
 * @return {null}
 */
DropboxSync.prototype._replaceLocalWithFolder = function (change, callback) {

  var localPath = this.toLocalPath(change.path);

  fs.stat(localPath, function (err, stat) {

    // handle errors
    if(err) {
      if(err.code === 'ENOENT') {
        // local path doesn't exist, create the folder
        return fs.mkdirs(localPath, callback);
      } else {
        // regular error
        return callback(err);
      }
    }

    // already a folder, nothing to see here
    if(stat.isDirectory) {
      return callback();
    }

    // not a folder, remove whatever is there...
    fs.remove(localPath, function (err) {
      if(err) return callback(err);

      // ... and replace it with a folder
      fs.mkdirs(localPath, callback);
    });
  });

};

// sugar for setTimeout
function delay(seconds, fn) {
  if(!seconds) {
    return setImmediate(fn);
  }

  return setTimeout(fn, seconds * 1000);
}

// dropbox likes to have paths with a leading slash
function normalizePath(path) {
  if(path && path[0] !== '/') {
    path = '/' + path;
  }

  return path;
}

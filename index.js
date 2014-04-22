var Dropbox = require('dropbox')
  , merge = require('merge')
  , fs = require('fs-extra')
  , async = require('async')
  , Path = require('path');

module.exports = DropboxSync;

/**
 * Create a new DropboxSync instance
 * @param {Object} dropboxConfig 
 * @param dropboxConfig {String} key Dropbox API key
 * @param dropboxConfig {String} secret Dropbox API secret
 * @param dropboxConfig {String} uid User's Dropbox UID
 * @param dropboxConfig {String} token User's OAuth Access token
 * @param {String} root Local path for the user's dropbox
 * @param {String} path Folder within dropbox to monitor
 */
function DropboxSync(dropboxConfig, root, path) {
  this.client = new Dropbox.Client({
    key: dropboxConfig.key,
    secret: dropboxConfig.secret,
    uid: dropboxConfig.uid,
    token: dropboxConfig.token
  });

  this.root = root;
  this.path = path;

  if(this.path[0] !== '/') {
    this.path = '/' + this.path;
  }

  this.cursor = null;

  this.watchingForChanges = null;
}

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
  var dbfs = new DropboxSync(options, localPath, syncPath);

  dbfs.sync(onError, onChange);

  return dbfs;
};

/**
 * Sync a specific folder to the local path
 * @param  {function(error)} onError  Evaluated when an error occurs. If triggered, this instance will not continue to sync.
 * @param  {function(Array)} onChange Evaluated every time a change occurs in the dropbox with an array of the modified paths.
 * @return {DropboxSync}
 */
DropboxSync.prototype.sync = function (onError, onChange) {
  var self = this;

  this.watchForChanges(function (err, changesMade) {
    if(err) return onError(err);

    // trigger the onChange
    onChange(changesMade.changes.map(function (change) {
      return self.toLocalPath(change.path);
    }));

    // reset
    self.sync(onError, onChange);
  });

  return this;
};

DropboxSync.prototype.stopSync = function (callback) {

  // abort the outstanding XHR
  this.watchingForChanges.abort();

  // change the flag
  this.watchingForChanges = null;

  // reset our local state
  fs.remove(this.root, callback);
};

/**
 * Watch for changes in a Dropbox folder, and commit them when they occur
 * @param  {Function} callback Evaluated with (err, changesMade) when a change occurs
 * @return {DropboxSync}
 */
DropboxSync.prototype.watchForChanges = function (callback) {
  var self = this;

  if(!this.cursor) {
    return this.pullChanges(callback);
  }

  if(this.watchingForChanges) return this;

  this.watchingForChanges = this.client.pollForChanges(this.cursor, function (err, pollResult) {
    if(err) return callback(err);

    console.log("Back from poll", pollResult);

    // no longer polling, don't do anything else
    if(!self.watchingForChanges) {
      console.log("we're not supposed to be watching for changes anymore");
      return;
    }

    if(!pollResult.hasChanges) {

      console.log("no changes right now. We'll try again in "+((pollResult.retryAfter || 0) * 1000));

      // if there are no changes, just set the poll again after the backoff period
      delay(pollResult.retryAfter, function () {
        self.watchForChanges(callback);
      });

    } else {
      console.log("got some changes! let's pull those.");

      self.pullChanges(callback);
    }

  });

  return this;
};

/**
 * Pull changes from a dropbox for a particular path
 * @param  {Function} callback Evaluated with (err, changesMade) after completion
 * @return {DropboxSync}
 */
DropboxSync.prototype.pullChanges = function (callback) {
  var self = this;

  this.client.pullChanges(this.cursor, function (err, pulledChanges) {
    if(err) return callback(err);

    self.cursor = pulledChanges;

    console.log("pulled some changes", pulledChanges);

    // filter change results if we're filtering that
    if(self.path) {
      pulledChanges.changes = pulledChanges.changes.filter(function (change) {
        return change.path.slice(0, self.path.length) === self.path;
      });
    }

    self.commitChanges(pulledChanges, callback);
  }); 

  return this;
};

/**
 * Reset the local path to an empty state
 * @param  {Function} callback Evaluated with (err, firstDirectoryMade) on completion
 * @return {DropboxSync}
 */
DropboxSync.prototype.resetDir = function(callback) {
  var dir = this.root;

  console.log("resetting home directory");

  fs.remove(dir, function (err) {
    if(err) return callback(err);

    fs.mkdirs(dir, callback);
  });

  return this;
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
DropboxSync.prototype.commitChanges = function(pulledChanges, callback) {
  var self = this;

  console.log("commiting changes", pulledChanges);
  
  async.series([

    // reset directory
    function (next) {
      if(pulledChanges.blankSlate) {
        self.resetDir(next);
      } else {
        next();
      }
    },

    // pull more changes
    function (next) {
      if(pulledChanges.shouldPullAgain) {
        console.log("it wants us to pull again... lets do it.");
        self.pullChanges(next);
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

  console.log("commiting change");

  if(change.wasRemoved) {
    console.log(change.path + " was deleted.");

    // delete file or folder
    fs.remove(this.toLocalPath(change.path), callback);

  } else if(change.stat.isFile) {
    console.log(change.path + " is a file.");

    this._replaceLocalWithFile(change, callback);

  } else if(change.stat.isFolder) {
    console.log(change.path + " is a folder.");

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

function delay(seconds, fn) {
  if(!seconds) {
    return setImmediate(fn);
  }

  return setTimeout(fn, seconds * 1000);
}

/*
 * Tiny JSON-file storage layer, replacing the abandoned diskdb dependency.
 *
 * Keeps diskdb's on-disk format: one <collection>.json file per collection,
 * each holding a plain JSON array of documents. Only the subset of the API
 * used by this service is implemented:
 *
 *   connect(dir, collections)   - exposes each collection as a <name> property
 *   <collection>.find([query])  -> array of matching documents
 *   <collection>.findOne(query) -> matching document or null
 *   <collection>.save(data)     -> inserts, assigns a fresh _id, returns the saved document(s)
 *   <collection>.update(query, data, {upsert}) -> shallow-merges data into the matches
 *   <collection>.remove(query)  -> removes the matches, returns true
 *
 * Writes are atomic (write to a temp file, then rename), so an interrupted
 * write can no longer destroy the previous data like a straight-overwrite
 * could.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function makeId() {
  // 32-char hex, compatible with the _ids already present in the data files
  return crypto.randomBytes(16).toString('hex');
}

// diskdb matched with loose equality; keep that behavior
function matches(doc, query) {
  for (var key in query) {
    if (doc[key] != query[key]) {
      return false;
    }
  }
  return true;
}

function Collection(file) {
  this.file = file;
  this.docs = this._read();
}

Collection.prototype._read = function() {
  if (!fs.existsSync(this.file)) {
    return [];
  }
  var docs = JSON.parse(fs.readFileSync(this.file, 'utf8'));
  if (!Array.isArray(docs)) {
    throw new Error(this.file + ' does not contain a JSON array');
  }
  return docs;
};

Collection.prototype._persist = function() {
  var tmp = this.file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(this.docs));
  fs.renameSync(tmp, this.file);
};

Collection.prototype.find = function(query) {
  if (query) {
    var matched = [];
    for (var i = 0; i < this.docs.length; i++) {
      if (matches(this.docs[i], query)) {
        matched.push(this.docs[i]);
      }
    }
    return matched;
  }
  return this.docs.slice();
};

Collection.prototype.findOne = function(query) {
  for (var i = 0; i < this.docs.length; i++) {
    if (matches(this.docs[i], query)) {
      // cloned: mutations (e.g. turning a job into a reprint) do not leak into the set
      return Object.assign({}, this.docs[i]);
    }
  }
  return null;
};

Collection.prototype.save = function(data) {
  var saved = Array.isArray(data) ? data.map(this._insert, this) : [this._insert(data)];
  this._persist();
  return saved.length === 1 ? saved[0] : saved;
};

Collection.prototype._insert = function(doc) {
  var record = Object.assign({}, doc);
  record._id = makeId();
  this.docs.push(record);
  return record;
};

Collection.prototype.update = function(query, data, options) {
  options = options || {};
  var updated = [];
  for (var i = 0; i < this.docs.length; i++) {
    if (matches(this.docs[i], query)) {
      Object.assign(this.docs[i], data);
      updated.push(Object.assign({}, this.docs[i]));
    }
  }
  if (updated.length === 0 && options.upsert) {
    var record = Object.assign({}, data);
    if (!record._id) {
      record._id = makeId();
    }
    this.docs.push(record);
    updated.push(record);
  }
  if (updated.length > 0) {
    this._persist();
  }
  return updated.length === 1 ? updated[0] : updated;
};

Collection.prototype.remove = function(query) {
  var before = this.docs.length;
  this.docs = this.docs.filter(function(doc) {
    return !matches(doc, query);
  });
  if (this.docs.length !== before) {
    this._persist();
  }
  return true;
};

var db = {
  connect: function(dir, collections) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    for (var i = 0; i < collections.length; i++) {
      var name = collections[i];
      this[name] = new Collection(path.join(dir, name + '.json'));
    }
    console.log('Successfully connected to: ' + dir);
    return this;
  }
};

module.exports = db;

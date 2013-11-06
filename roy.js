/*
 * Roy
 * https://github.com/jo/roy
 *
 * Replication Algorithm (and comments) taken from
 * https://github.com/couchbaselabs/TouchDB-iOS/wiki/Replication-Algorithm
 * by Jens Alfke
 *
 * Copyright (c) 2013 Johannes J. Schmidt
 * Licensed under the MIT license.
 */

'use strict';

var crypto = require('crypto');
var nano = require('nano');
var async= require('async');

exports.replicate = function replicate(options, callback) {
  options.batch_size = options.batch_size || 100;

  var result = {
    docs_read: 0,
    docs_written: 0
  };

  // Reference to the changes feed, to allow to cancel in continuous mode
  var changes;

  if (!callback) {
    callback = function() {};
  }

  // Get a unique identifier from the source database (which may just be its URL).
  // Use this identifier to generate the doc ID of a special (_local,
  // non-replicated) document of the target database, to look up a stored value:
  // the last source sequence ID (also called a “checkpoint”) that was read and
  // processed by the previous replication. (It’s OK if this value is missing for
  // some reason; it’s just an optimization.)
  function getCheckpointDoc(callback) {
    var identifier = crypto
      .createHash('md5')
      .update(options.source.config.url)
      .update('/')
      .update(options.source.config.db)
      .digest("hex");

    var doc = {
      _id: '_local/' + identifier,
      last_seq: 0
    };

    options.target.get(doc._id, function(err, targetDoc) {
      if (err) {
        return callback(null, doc);
      }
      options.source.get(doc._id, function(err, sourceDoc) {
        if (err) {
          return callback(null, doc);
        }
        if (targetDoc.last_seq !== sourceDoc.last_seq) {
          return callback(null, doc);
        }
        callback(null, sourceDoc);
      });
    });
  }

  // After a group of revisions is stored, save a checkpoint: update the last
  // source sequence ID value in the target database. It should be the latest
  // sequence ID for which its revision and all prior to it have been added to
  // the target. (Even if some revisions are rejected by a target validation
  // handler, they still count as ‘added’ for this purpose.)
  function storeCheckpoint(changes, checkpointDoc, callback) {
    checkpointDoc.last_seq = changes.last_seq;
    options.target.insert(checkpointDoc, checkpointDoc._id, function() {
      options.source.insert(checkpointDoc, checkpointDoc._id, callback);
    });
  }

  // Fetch the source database’s _changes feed, starting just past the last source
  // sequence ID (if any). Use the “?style=all_docs” URL parameter so that
  // conflicting revisions will be included. In continuous replication you should
  // use the “?feed=longpoll” or “?feed=continuous” mode and leave the algorithm
  // running indefinitely to process changes as they occur. Filtered replication
  // will specify the name of a filter function in this URL request.
  function getChanges(checkpointDoc, callback) {
    var changesOptions = {
      since: checkpointDoc.last_seq,
      limit: options.batch_size
    };
    if (options.doc_ids) {
      changesOptions.filter = '_doc_ids';
      changesOptions.doc_ids = typeof options.doc_ids === 'string' ?
        options.doc_ids :
        JSON.stringify(options.doc_ids);
    }
    if (options.filter) {
      changesOptions.filter = options.filter;
    }
    if (options.query_params) {
      changesOptions.query_params = options.query_params;
    }
    if (options.firstRunComplete) {
      changesOptions.feed = 'longpoll';
    }
    changes = options.source.changes(changesOptions, callback);
  }

  // Collect a group of document/revision ID pairs from the _changes feed and
  // send them to the target database’s _revs_diff. The result will contain the
  // subset of those revisions that are not in the target database.
  function getRevsDiff(changes, callback) {
    var diffs = changes.results.reduce(function(memo, result) {
      memo[result.id] = result.changes.map(function(change) { return change.rev; });
      return memo;
    }, {});

    nano(options.target.config.url).request({
      db: options.target.config.db,
      path: '_revs_diff',
      method: 'POST',
      body: diffs
    }, callback);
  }

  // GET each such revision from the source database. Use the ?revs=true URL
  // parameter to include its list of parent revisions, so the target database
  // can update its revision tree. Use “?attachments=true” so the revision data
  // will include attachment bodies. Also use the “?atts_since” query parameter
  // to pass a list of revisions that the target already has, so the source can
  // optimize by not including the bodies of attachments already known to the
  // target.
  //
  // Performance:
  //
  // From my [Jens Alfke] limited testing, the performance bottleneck in the
  // current algorithm seems to be in fetching the new revisions from the
  // source. I think this is due to the overhead of handling many separate HTTP
  // requests.  It should be possible to speed up replication by introducing a
  // new API call that fetches revisions in bulk. (The _all_docs call can fetch
  // a list of revisions, but currently can’t be told to include revision
  // histories.)
  //
  // A limited case of the above-mentioned bulk-get optimization is possible
  // with the current API: revisions of generation 1 (revision ID starts with
  // “1-”) can be fetched in bulk via _all_docs, because by definition they have
  // no revision histories. Unfortunately _all_docs can’t include attachment
  // bodies, so if it returns a document whose JSON indicates it has
  // attachments, those will have to be fetched separately. Nonetheless, this
  // optimization can help significantly, and is currently implemented in
  // TouchDB.
  function getRevisions(missingRevs, callback) {
    var ids = Object.keys(missingRevs);
    var generationOneIds = ids.filter(function(id) {
      var missing = missingRevs[id].missing;
      return missing.length === 1 && parseInt(missing[0], 10) === 1;
    });
    var generationOneRevs = ids.reduce(function(memo, id) {
      memo[id] = missingRevs[id].missing[0];
      return memo;
    }, {});
    var otherIds = ids.filter(function(id) {
      var missing = missingRevs[id].missing;
      return missing.length > 1 || parseInt(missing[0], 10) > 1;
    });
    
    // TODO: get generation one revisions and the other revisions should be done
    // paralell.
    getGenerationOneRevisions(generationOneIds, generationOneRevs, function(err, generationOneDocs) {
      async.map(otherIds, function(id, next) {
        var revs = missingRevs[id].missing;
        var knownRevs = [];
        async.mapSeries(revs, function(rev, cb) {
          options.source.get(id, {
            rev: rev,
            revs: true,
            attachments: true,
            atts_since: knownRevs
          }, cb);
          knownRevs.push(rev);
        }, next);
      }, function(err, docs) {
        // concat and flatten result
        callback(err, generationOneDocs.concat.apply(generationOneDocs, docs));
      });
    });
  }

  function getGenerationOneRevisions(ids, revs, callback) {
    if (!ids.length) {
      return callback(null, []);
    }
    
    options.source.fetch({
      keys: ids
    }, {
      include_docs: true
    }, function(err, result) {
      // fetch attachments, deleted docs and generation > 1 docs
      async.map(result.rows, function(row, next) {
        var needsFetching = row.value.deleted ||
          (row.doc._attachments && Object.keys(row.doc._attachments).length > 0) ||
          parseInt(row.doc._rev, 10) > 1;

        if (!needsFetching) {
          return next(null, row.doc);
        }

        // TODO: an optimisation would be to only fetch the attachments via
        // standalone attachments api and then encode them base64 and construct
        // the attachment stub
        options.source.get(row.id, {
          rev: revs[row.id],
          revs: true,
          attachments: true
        }, next);
      }, callback);
    });
  }

  // Collect a group of revisions fetched by the previous step, and store them
  // into the target database using the _bulk_docs API, with the new_edits:false
  // JSON property to preserve their revision IDs.
  function saveRevisions(docs, callback) {
    options.target.bulk({
      docs: docs,
      new_edits: false
    }, callback);
  }

  getCheckpointDoc(function(err, checkpointDoc) {
    if (err) {
     return callback(err);
    }

    getChanges(checkpointDoc, function(err, changes) {
      if (err) {
       return callback(err);
      }

      getRevsDiff(changes, function(err, missingRevs) {
        if (err) {
         return callback(err);
        }

        getRevisions(missingRevs, function(err, docs) {
          if (err) {
           return callback(err);
          }

          var docsCount = docs.reduce(function(sum, doc) {
            if (doc._revisions) {
              sum += doc._revisions.ids.length;
            } else {
              sum++;
            }
            return sum;
          }, 0);
          result.docs_read += docsCount;

          saveRevisions(docs, function(err) {
            if (err) {
             return callback(err);
            }

            result.docs_written += docsCount;

            storeCheckpoint(changes, checkpointDoc, function(err) {
              if (err) {
               return callback(err);
              }
              if (changes.results.length === options.batch_size) {
                return replicate(options, callback);
              }

              if (options.continuous) {
                options.firstRunComplete = true;
                return replicate(options, callback);
              }

              result.ok = true;
              callback(null, result);
            });
          });
        });
      });
    });
  });

  return {
    cancel: function() {
      changes.abort();
    }
  };
};

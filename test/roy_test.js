'use strict';

var roy = require('../lib/roy.js');

/*
  ======== A Handy Little Nodeunit Reference ========
  https://github.com/caolan/nodeunit

  Test methods:
    test.expect(numAssertions)
    test.done()
  Test assertions:
    test.ok(value, [message])
    test.equal(actual, expected, [message])
    test.notEqual(actual, expected, [message])
    test.deepEqual(actual, expected, [message])
    test.notDeepEqual(actual, expected, [message])
    test.strictEqual(actual, expected, [message])
    test.notStrictEqual(actual, expected, [message])
    test.throws(block, [error], [message])
    test.doesNotThrow(block, [error], [message])
    test.ifError(value)
*/

exports['replicate'] = {
  setUp: function(done) {
    var server = 'http://localhost:5984';
    var source = 'roy-source';
    var target = 'roy-target';
    var nano = require('nano')(server);
    this.source = nano.db.use(source);
    this.target = nano.db.use(target);

    var docs = [];
    for (var i = 0; i < 100; i++) {
      docs.push({
        _id: i.toString(),
        i: i
      });
    }

    nano.db.destroy(source, function() {
      nano.db.destroy(target, function() {
        nano.db.create(source, function() {
          nano.db.create(target, function() {
            nano.db.use(source).bulk({ docs: docs }, function() {
              done();
            });
          });
        });
      });
    });
  },
  'basic pull replication': function(test) {
    test.expect(2);

    roy.replicate({ source: this.source, target: this.target }, function(err, resp) {
      test.ok(!err, 'no error should have been occured');
      test.ok(resp.ok, 'resp should be ok');
      test.done();
    });
  },
};

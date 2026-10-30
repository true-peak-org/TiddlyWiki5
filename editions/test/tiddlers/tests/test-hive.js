/*\
title: test-hive.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Tests for the Hive storage plugin.

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var util = require("$:/plugins/tiddlywiki/hive/hiveutil.js"),
		HiveStore = require("$:/plugins/tiddlywiki/hive/hivestore.js").HiveStore;

	describe("Hive plugin", function() {

		describe("hiveutil", function() {

			it("should hash strings consistently", function() {
				expect(util.hashString("HelloThere")).toBe(util.hashString("HelloThere"));
				expect(util.hashString("HelloThere")).not.toBe(util.hashString("HelloThere "));
				expect(util.hashString("HelloThere").length).toBe(16);
			});

			it("should slugify titles", function() {
				expect(util.slugify("Hello There")).toBe("hello_there");
				expect(util.slugify("A/B/C")).toBe("a_b_c");
				expect(util.slugify("  spaced  ")).toBe("spaced");
			});

			it("should generate stable permlinks", function() {
				var permlink = util.getTiddlerPermlink("wikiid","HelloThere");
				expect(permlink).toBe(util.getTiddlerPermlink("wikiid","HelloThere"));
				expect(permlink).not.toBe(util.getTiddlerPermlink("otherwiki","HelloThere"));
				expect(permlink).not.toBe(util.getTiddlerPermlink("wikiid","HelloThere!"));
				expect(permlink.indexOf("tw5_hellothere_")).toBe(0);
			});

			it("should generate a stable permlink for the root post", function() {
				var permlink = util.getRootPermlink("wikiid","My Wiki");
				expect(permlink).toBe(util.getRootPermlink("wikiid","My Wiki"));
				expect(permlink).not.toBe(util.getRootPermlink("otherwiki","My Wiki"));
			});

			it("should convert a tiddler into a payload and back", function() {
				var wiki = new $tw.Wiki();
				wiki.addTiddler(new $tw.Tiddler({
					title: "HelloThere",
					text: "Welcome to my wiki",
					tags: ["one","two"],
					colour: "red"
				}));
				var tiddler = wiki.getTiddler("HelloThere"),
					payload = util.getTiddlerPayload(tiddler),
					restored = util.payloadToTiddler(payload);
				expect(payload.title).toBe("HelloThere");
				expect(payload.text).toBe("Welcome to my wiki");
				expect(payload.tags).toEqual(["one","two"]);
				expect(payload.fields.colour).toBe("red");
				expect(payload.fields.text).toBeUndefined();
				expect(restored.fields.text).toBe("Welcome to my wiki");
				expect(restored.fields.tags).toEqual(["one","two"]);
				expect(restored.fields.colour).toBe("red");
			});

			it("should hash a payload consistently", function() {
				var payload = {title: "a",text: "b",fields: {},tags: []};
				expect(util.getPayloadHash(payload)).toBe(util.getPayloadHash(payload));
				expect(util.getPayloadHash(payload)).not.toBe(util.getPayloadHash({title: "a",text: "c",fields: {},tags: []}));
			});

			it("should convert wikitext into markdown", function() {
				expect(util.wikitextToMarkdown("! Heading")).toBe("# Heading");
				expect(util.wikitextToMarkdown("''bold''")).toBe("**bold**");
				expect(util.wikitextToMarkdown("//italic//")).toBe("*italic*");
				expect(util.wikitextToMarkdown("{{{code}}}")).toBe("`code`");
				expect(util.wikitextToMarkdown("* one")).toBe("- one");
				expect(util.wikitextToMarkdown("** one")).toBe("  - one");
				expect(util.wikitextToMarkdown("[[Label|target]]")).toBe("[Label](target)");
			});

			it("should resolve the links of a tiddler to the urls of the replies", function() {
				var markdown = util.wikitextToMarkdown("See [[Other]]",function(title) {
					return title === "Other" ? "https://hive.blog/@me/tw5_other_1234" : null;
				});
				expect(markdown).toBe("See [Other](https://hive.blog/@me/tw5_other_1234)");
			});

			it("should convert a code block into a fenced code block", function() {
				expect(util.wikitextToMarkdown("<<<\nvar a = 1;\n<<<")).toBe("```\nvar a = 1;\n```");
			});

			it("should not confuse the urls of the links with the italic markup", function() {
				var markdown = util.wikitextToMarkdown("A [[One]] and a [[Two|https://example.com]]",function(title) {
					return title === "One" ? "https://hive.blog/@me/tw5_one_1234" : null;
				});
				expect(markdown).toBe("A [One](https://hive.blog/@me/tw5_one_1234) and a [Two](https://example.com)");
			});

			it("should make the body of a tiddler", function() {
				var body = util.makeTiddlerBody({title: "HelloThere",text: "Welcome"},{frontEnd: "https://hive.blog"});
				expect(body.indexOf("# HelloThere")).toBeGreaterThan(-1);
				expect(body.indexOf("Welcome")).toBeGreaterThan(-1);
				expect(body.indexOf("TiddlyWiki5")).toBeGreaterThan(-1);
			});

			it("should truncate long titles", function() {
				var title = util.makeTitle(new Array(500).join("a"));
				expect(title.length).toBeLessThan(util.MAX_TITLE_LENGTH + 1);
			});
		});

		describe("HiveStore", function() {

			var wiki;

			beforeEach(function() {
				wiki = new $tw.Wiki();
				wiki.addTiddler(new $tw.Tiddler({title: "$:/SiteTitle",text: "Test Wiki"}));
				wiki.addTiddler(new $tw.Tiddler({title: "HelloThere",text: "Welcome"}));
				wiki.addTiddler(new $tw.Tiddler({title: "Parent",text: "The parent"}));
				wiki.addTiddler(new $tw.Tiddler({title: "Parent/Child",text: "Nested"}));
			});

			it("should read the configuration with its defaults", function() {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig();
				expect(config.account).toBe("");
				expect(config.category).toBe("tiddlywiki5");
				expect(config.nesting).toBe("path");
				expect(config.pullMode).toBe("overwrite");
				expect(config.frontEnd).toBe("https://hive.blog");
			});

			it("should read the configuration from the config tiddlers", function() {
				wiki.addTiddler(new $tw.Tiddler({title: "$:/config/tiddlywiki/hive/account",text: "someone"}));
				wiki.addTiddler(new $tw.Tiddler({title: "$:/config/tiddlywiki/hive/category",text: "wikis"}));
				var config = new HiveStore({wiki: wiki}).getConfig();
				expect(config.account).toBe("someone");
				expect(config.category).toBe("wikis");
			});

			it("should give the same identifier to the same wiki", function() {
				var store = new HiveStore({wiki: wiki}),
					id = store.getWikiId();
				expect(id).toBe(store.getWikiId());
				expect(id.length).toBe(32);
			});

			it("should order the tiddlers so that the parents come first", function() {
				var store = new HiveStore({wiki: wiki}),
					order = store.orderTitles(["Parent/Child","HelloThere","Parent"],{nesting: "path"});
				expect(order.indexOf("Parent")).toBeLessThan(order.indexOf("Parent/Child"));
				expect(order.length).toBe(3);
			});

			it("should build the operations for the root post and the tiddlers", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig();
				store.buildOperations(config,store.getWikiId(),"Test Wiki","tw5_root_1234",null,[],["HelloThere","Parent/Child"],function(err,operations) {
					expect(err).toBeNull();
					// The root post comes first
					expect(operations[0].permlink).toBe("tw5_root_1234");
					expect(operations[0].parent_permlink).toBe("tiddlywiki5");
					expect(operations[0].parent_author).toBe("");
					// Then the tiddlers
					expect(operations.length).toBe(3);
					operations.slice(1).forEach(function(operation) {
						expect(operation.parent_permlink).toBe("tw5_root_1234");
						expect(operation.type).toBe("comment");
						var metadata = JSON.parse(operation.json_metadata);
						expect(metadata.app).toBe("tw5");
						expect(metadata.tw5.title).toBeDefined();
					});
					done();
				});
			});

			it("should not rebuild the operations of the tiddlers that have not changed", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig();
				store.buildOperations(config,"wikiid","Test Wiki","tw5_root_1234",null,[],["HelloThere"],function(err,operations) {
					var reply = {
						permlink: util.getTiddlerPermlink("wikiid","HelloThere"),
						json_metadata: JSON.stringify({app: "tw5",tw5: {
							type: "tiddler",
							title: "HelloThere",
							text: "Welcome",
							fields: {},
							tags: [],
							created: "",
							modified: "",
							part: 1,
							parts: 1,
							hash: util.getPayloadHash({title: "HelloThere",text: "Welcome",fields: {},tags: [],created: "",modified: "",part: 1,parts: 1})
						}})
					};
					store.buildOperations(config,"wikiid","Test Wiki","tw5_root_1234",null,[reply],["HelloThere"],function(err2,operations2) {
						// Only the root post is left
						expect(operations2.length).toBe(1);
						expect(operations2[0].permlink).toBe("tw5_root_1234");
						done();
					});
				});
			});

			it("should mark the tiddlers that have been removed", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig();
				var reply = {
					permlink: util.getTiddlerPermlink("wikiid","Gone"),
					json_metadata: JSON.stringify({app: "tw5",tw5: {type: "tiddler",title: "Gone",text: "Old",hash: "abc"}})
				};
				store.buildOperations(config,"wikiid","Test Wiki","tw5_root_1234",null,[reply],[],function(err,operations) {
					var tombstone = operations.filter(function(operation) {
						return operation.permlink === reply.permlink;
					});
					expect(tombstone.length).toBe(1);
					expect(JSON.parse(tombstone[0].json_metadata).tw5.deleted).toBe(true);
					done();
				});
			});

			it("should nest the replies underneath the reply of their parent", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig();
				store.buildOperations(config,"wikiid","Test Wiki","tw5_root_1234",null,[],["Parent","Parent/Child"],function(err,operations) {
					var child = operations.filter(function(operation) {
							return JSON.parse(operation.json_metadata).tw5.title === "Parent/Child";
						})[0],
						parent = operations.filter(function(operation) {
							return JSON.parse(operation.json_metadata).tw5.title === "Parent";
						})[0];
					expect(child.parent_permlink).toBe(parent.permlink);
					done();
				});
			});

			it("should not publish the tiddlers that have already been published", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig(),
					hash = util.getPayloadHash({title: "HelloThere",text: "Welcome",fields: {},tags: [],created: "",modified: "",part: 1,parts: 1});
				wiki.addTiddler(new $tw.Tiddler({title: "$:/config/tiddlywiki/hive/remote",text: JSON.stringify({
					wikiid: "wikiid",
					permlink: "tw5_root_1234",
					tiddlers: {HelloThere: {permlink: util.getTiddlerPermlink("wikiid","HelloThere"),hashes: {1: hash}}}
				})}));
				store.buildOperations(config,"wikiid","Test Wiki","tw5_root_1234",null,[],["HelloThere"],function(err,operations) {
				// Only the root post is left
					expect(operations.length).toBe(1);
					expect(operations[0].permlink).toBe("tw5_root_1234");
					done();
				});
			});

			it("should collect the replies of the replies", function(done) {
				var store = new HiveStore({wiki: wiki}),
					calls = [];
				store.api = {
					getReplies: function(author,permlink,callback) {
						calls.push(permlink);
						if(permlink === "root") {
							return callback(null,[{author: "someone",permlink: "reply1",children: 1}]);
						}
						if(permlink === "reply1") {
							return callback(null,[{author: "someone",permlink: "reply2",children: 0}]);
						}
						callback(null,[]);
					}
				};
				store.getAllReplies("someone","root",function(err,replies) {
					expect(err).toBeNull();
					expect(replies.length).toBe(2);
					expect(replies[0].permlink).toBe("reply1");
					expect(replies[1].permlink).toBe("reply2");
					// The replies that have no children are not looked at
					expect(calls.length).toBe(2);
					done();
				});
			});

			it("should save the wiki with the operations of the root post and the tiddlers", function(done) {
				var store = new HiveStore({wiki: wiki}),
					broadcasted = [];
				store.api = {
					getContent: function(author,permlink,callback) {
						expect(author).toBe("someone");
						callback(null,null);
					},
					getReplies: function(author,permlink,callback) {
						callback(null,[]);
					}
				};
				store.keychain = {
					broadcast: function(username,operations,method,callback) {
						broadcasted.push(operations);
						callback(null,{id: "tx"});
					}
				};
				wiki.addTiddler(new $tw.Tiddler({title: "$:/config/tiddlywiki/hive/account",text: "someone"}));
				store.save(function(err,result) {
					expect(err).toBeNull();
					expect(broadcasted.length).toBe(1);
					expect(broadcasted[0].length).toBe(4);
					// The root post comes first
					expect(broadcasted[0][0].permlink).toBe(result.permlink);
					expect(broadcasted[0][0].parent_permlink).toBe("tiddlywiki5");
					// The replies of the tiddlers
					expect(broadcasted[0][1].parent_permlink).toBe(result.permlink);
					// The state of the last save is recorded
					var state = JSON.parse(wiki.getTiddlerText("$:/config/tiddlywiki/hive/remote"));
					expect(state.permlink).toBe(result.permlink);
					expect(state.tiddlers.HelloThere).toBeDefined();
					done();
				});
			});

			it("should add the tiddlers of the replies to the wiki", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig(),
					replies = [{
						permlink: "tw5_Loaded_1234",
						json_metadata: JSON.stringify({app: "tw5",tw5: {
							type: "tiddler",
							title: "Loaded",
							text: "Welcome back",
							fields: {colour: "red"},
							tags: ["one"],
							part: 1,
							parts: 1
						}})
					}];
				store.applyReplies(config,{type: "root",wikiid: "wikiid"},replies,function(err,summary) {
					expect(err).toBeNull();
					expect(summary.added).toBe(1);
					var tiddler = wiki.getTiddler("Loaded");
					expect(tiddler.fields.text).toBe("Welcome back");
					expect(tiddler.fields.colour).toBe("red");
					expect(tiddler.fields.tags).toEqual(["one"]);
					done();
				});
			});

			it("should keep the existing tiddlers when the pull mode is merge", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig();
				config.pullMode = "merge";
				var replies = [{
					permlink: "tw5_HelloThere_1234",
					json_metadata: JSON.stringify({app: "tw5",tw5: {
						type: "tiddler",
						title: "HelloThere",
						text: "Welcome back",
						fields: {},
						tags: [],
						part: 1,
						parts: 1
					}})
				}];
				store.applyReplies(config,{type: "root",wikiid: "wikiid"},replies,function(err,summary) {
					expect(summary.skipped).toBe(1);
					expect(wiki.getTiddler("HelloThere").fields.text).toBe("Welcome");
					done();
				});
			});

			it("should reassemble the tiddlers that are split over several replies", function(done) {
				var store = new HiveStore({wiki: wiki}),
					config = store.getConfig(),
					replies = [
						{permlink: "tw5_Big_1",json_metadata: JSON.stringify({app: "tw5",tw5: {type: "tiddler",title: "Big",text: "one ",fields: {},tags: [],part: 1,parts: 2}})},
						{permlink: "tw5_Big_2",json_metadata: JSON.stringify({app: "tw5",tw5: {type: "tiddler",title: "Big",text: "two",fields: {},tags: [],part: 2,parts: 2}})}
					];
				store.applyReplies(config,{type: "root",wikiid: "wikiid"},replies,function(err,summary) {
					expect(wiki.getTiddler("Big").fields.text).toBe("one two");
					done();
				});
			});

		});
	});

})();

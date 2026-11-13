/*\
title: $:/plugins/tiddlywiki/hive/hiveactions.js
type: application/javascript
module-type: widget

Action widgets that save a wiki to Hive and load a wiki from Hive.

Usage:

	<$button><$action-hivesave/>Save to Hive</$button>
	<$button><$action-hiveload permlink="tw5-..."/>Load from Hive</$button>

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var Widget = require("$:/core/modules/widgets/widget.js").widget,
		HiveStore = require("$:/plugins/tiddlywiki/hive/hivestore.js").HiveStore,
		HiveApi = require("$:/plugins/tiddlywiki/hive/hiveapi.js").HiveApi,
		HiveKeychain = require("$:/plugins/tiddlywiki/hive/hivekeychain.js").HiveKeychain,
		HiveLink = require("$:/plugins/tiddlywiki/hive/hivelink.js"),
		util = require("$:/plugins/tiddlywiki/hive/hiveutil.js");

	var HiveActionWidget = function(parseTreeNode,options) {
		this.initialise(parseTreeNode,options);
	};

	/*
Inherit from the base widget class
*/
	HiveActionWidget.prototype = new Widget();

	/*
Render this widget into the DOM
*/
	HiveActionWidget.prototype.render = function(parent,nextSibling) {
		this.parentDomNode = parent;
		this.computeAttributes();
		this.execute();
		this.renderChildren(parent,nextSibling);
	};

	/*
Compute the internal state of the widget
*/
	HiveActionWidget.prototype.execute = function() {
		this.action = this.getAttribute("action") || this.getDefaultAction();
		this.author = this.getAttribute("author","");
		this.canonical = this.getAttribute("canonical","no");
		this.permlink = this.getAttribute("permlink","") || this.wiki.getTiddlerText("$:/config/tiddlywiki/hive/permalink") || "";
		this.makeChildWidgets();
	};

	/*
Return the action that matches the tag of the widget, so that
<$action-hiveload/> means load even without an explicit action attribute
*/
	HiveActionWidget.prototype.getDefaultAction = function() {
		var type = this.parseTreeNode ? this.parseTreeNode.type : "",
			match = /^action-hive(\w+)$/.exec(type);
		return match ? match[1] : "save";
	};

	/*
Refresh the widget by ensuring our attributes are up to date
*/
	HiveActionWidget.prototype.refresh = function(changedTiddlers) {
		var changedAttributes = this.computeAttributes();
		if($tw.utils.count(changedAttributes) > 0) {
			this.refreshSelf();
			return true;
		}
		return this.refreshChildren(changedTiddlers);
	};

	/*
Create a store that talks to the configured Hive endpoint
*/
	HiveActionWidget.prototype.createStore = function() {
		var store = new HiveStore({wiki: this.wiki}),
			config = store.getConfig();
		store.api = new HiveApi({rpc: config.rpc});
		store.keychain = new HiveKeychain({rpc: config.rpc});
		return store;
	};

	/*
Report the outcome of the operation
*/
	HiveActionWidget.prototype.report = function(err) {
		var store = this.createStore();
		if(err) {
			store.setStatus("Error: " + err);
			$tw.utils.error("Hive: " + err);
		} else {
			$tw.utils.log("Hive: " + store.getStatusText());
		}
	};

	/*
Invoke the action associated with this widget
*/
	HiveActionWidget.prototype.invokeAction = function(triggeringWidget,event) {
		var self = this,
			store = this.createStore(),
			config = store.getConfig();
		if(this.action === "link") {
		// Load a single Hive post as a tiddler
			HiveLink.loadPost(this.author,this.permlink,{wiki: this.wiki,rpc: config.rpc},function(err,result) {
				if(err) {
					store.setStatus("Error: " + err);
					$tw.utils.error("Hive: " + err);
					return;
				}
				store.setStatus(result.unchanged ?
					("The Hive post @" + self.author + "/" + self.permlink + " is already up to date") :
					("Loaded the Hive post @" + self.author + "/" + self.permlink + " as the tiddler " + result.title));
				// The canonical url opens the wiki reader that the post belongs to
				if(result.canonicalUrl && (self.canonical === "yes" || self.canonical === "true")) {
					window.open(result.canonicalUrl,"_blank");
				} else {
					// Navigate from this widget so that the event bubbles up
					// through the Navigator: it opens the tiddler in the story
					// and scrolls it into view like a wikilink does
					var rect = event && event.target && event.target.getBoundingClientRect && event.target.getBoundingClientRect();
					self.dispatchEvent({
						type: "tm-navigate",
						navigateTo: result.title,
						navigateFromClientRect: rect ? {
							top: rect.top,
							left: rect.left,
							width: rect.width,
							right: rect.right,
							bottom: rect.bottom,
							height: rect.height
						} : undefined
					});
				}
			});
			return true;
		}
		if(this.action === "new") {
		// Start a new wiki: forget the loaded or saved wiki so that the
		// next save publishes a new root post to the configured account
			store.newWiki(function(err) {
				self.report(err);
			});
		} else if(this.action === "approve") {
		// Approve the proposals of the other accounts to the wiki that
		// has been loaded last: only the owner of the wiki can do this
			store.approvePending(function(err) {
				self.report(err);
			});
		} else if(this.action === "load") {
			store.load(this.permlink,function(err) {
				self.report(err);
			});
		} else if(this.action === "inspect") {
			// Prepare the operations of a save and show them in a preview
			// tiddler, without broadcasting anything
			store.prepareOperations(function(err,operations,context) {
				if(err) {
					self.report(err);
					return;
				}
				self.showOperationPreview(store,operations,context,event);
			});
		} else {
			store.save(function(err) {
				self.report(err);
			});
		}
		return true;
	};

	/*
Write the operations that a save would broadcast into a preview tiddler
and open it. The operations are grouped into the transactions that would
be sent to Keychain for signing
*/
	HiveActionWidget.prototype.showOperationPreview = function(store,operations,context,event) {
		var title = "$:/hive/preview/operations",
			text,
			status;
		if(operations.length) {
			// Every operation is broadcast in its own transaction, the chain
			// rejects a transaction that creates more than one comment
			var transactions = operations.map(function(operation) {
				return {
					characters: util.getOperationSize(operation),
					operations: [util.getWireOperation(operation)]
				};
			});
			text = JSON.stringify({
				account: context.config.account,
				owner: context.owner,
				mode: context.mode,
				method: "Posting",
				transactionCount: transactions.length,
				transactions: transactions
			},null,2);
			status = "Prepared " + operations.length + " operation(s) in " + transactions.length + " transaction(s) for review. Nothing has been broadcast.";
		} else {
			text = "Nothing to broadcast, the post " + context.rootPermlink + " is up to date";
			status = text;
		}
		// The $:/ prefix and the external tag keep the preview out of the
		// published tiddlers even if the publish filter is changed
		store.wiki.addTiddler(new $tw.Tiddler({
			title: title,
			text: text,
			type: "text/plain",
			tags: ["$:/hive/external"]
		}));
		store.setStatus(status);
		// Navigate from this widget so that the event bubbles up through
		// the Navigator: it opens the preview in the story and scrolls it
		// into view like a wikilink does
		var rect = event && event.target && event.target.getBoundingClientRect && event.target.getBoundingClientRect();
		this.dispatchEvent({
			type: "tm-navigate",
			navigateTo: title,
			navigateFromClientRect: rect ? {
				top: rect.top,
				left: rect.left,
				width: rect.width,
				right: rect.right,
				bottom: rect.bottom,
				height: rect.height
			} : undefined
		});
	};

	exports["action-hivesave"] = HiveActionWidget;
	exports["action-hiveload"] = HiveActionWidget;
	exports["action-hivelink"] = HiveActionWidget;
	exports["action-hiveinspect"] = HiveActionWidget;
	exports["action-hivenew"] = HiveActionWidget;
	exports["action-hiveapprove"] = HiveActionWidget;

})();

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
		HiveKeychain = require("$:/plugins/tiddlywiki/hive/hivekeychain.js").HiveKeychain;

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
		this.action = this.getAttribute("action","save");
		this.permlink = this.getAttribute("permlink","") || this.wiki.getTiddlerText("$:/config/tiddlywiki/hive/permalink") || "";
		this.makeChildWidgets();
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
			store = this.createStore();
		if(this.action === "load") {
			store.load(this.permlink,function(err) {
				self.report(err);
			});
		} else {
			store.save(function(err) {
				self.report(err);
			});
		}
		return true;
	};

	exports["action-hivesave"] = HiveActionWidget;
	exports["action-hiveload"] = HiveActionWidget;

})();

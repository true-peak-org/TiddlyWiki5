/*\
title: $:/plugins/tiddlywiki/hive/hive-imagepreview.js
type: application/javascript
module-type: widget

Preview widget for the copies of an image that a save to Hive publishes.
It shows the image that results from the image settings of the tiddler and
its size, so that the copy that is uploaded to the image hoster of Hive and
the copy that is stored on the chain can be judged before a save.

Usage:

	<$hive-imagepreview title="My image.webp" dest="cdn"/>
	<$hive-imagepreview title="My image.webp" dest="chain"/>

The dest attribute selects the copy: "cdn" is the hosted copy that is
uploaded to images.hive.blog, "chain" is the copy that is stored inside the
replies of the wiki. Without a dest the hosted copy is shown. The widget
updates itself when the tiddler or its image settings change.

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var Widget = require("$:/core/modules/widgets/widget.js").widget,
		HiveStore = require("$:/plugins/tiddlywiki/hive/hivestore.js").HiveStore,
		util = require("$:/plugins/tiddlywiki/hive/hiveutil.js");

	var HiveImagePreviewWidget = function(parseTreeNode,options) {
		this.initialise(parseTreeNode,options);
	};

	/*
Inherit from the base widget class
	*/
	HiveImagePreviewWidget.prototype = new Widget();

	/*
Compute the internal state of the widget
	*/
	HiveImagePreviewWidget.prototype.execute = function() {
		this.previewTitle = this.getAttribute("title","");
		this.previewDest = this.getAttribute("dest","cdn") === "chain" ? "chain" : "cdn";
		this.previewToken = 0;
	};

	/*
Refresh the widget when its attributes or the tiddler change
	*/
	HiveImagePreviewWidget.prototype.refresh = function(changedTiddlers) {
		var changedAttributes = this.computeAttributes();
		if($tw.utils.count(changedAttributes) > 0 || changedTiddlers[this.previewTitle]) {
			this.refreshSelf();
			return true;
		}
		return this.refreshChildren(changedTiddlers);
	};

	/*
Render the container of the preview and start the computation of the copy
	*/
	HiveImagePreviewWidget.prototype.render = function(parent,nextSibling) {
		this.parentDomNode = parent;
		this.computeAttributes();
		this.execute();
		// The container holds the image and the information line that the
		// computation fills in
		this.domNode = this.document.createElement("div");
		this.domNode.className = "hive-imagepreview";
		this.domNode.setAttribute("data-hive-dest",this.previewDest);
		this.domNode.style.cssText = "display:inline-block;vertical-align:top;margin:0.5em 0.5em 0.5em 0;text-align:center;";
		this.infoNode = this.document.createElement("span");
		this.infoNode.className = "hive-imagepreview-info";
		this.infoNode.style.cssText = "display:block;font-size:0.85em;color:#666;white-space:nowrap;";
		this.infoNode.textContent = "preparing ...";
		this.domNode.appendChild(this.infoNode);
		parent.insertBefore(this.domNode,nextSibling);
		this.domNodes.push(this.domNode);
		this.renderChildren(this.domNode,null);
		this.compute();
	};

	/*
Compute the copy of the image that this preview shows and fill in the
image and the information line
	*/
	HiveImagePreviewWidget.prototype.compute = function() {
		var self = this,
			title = this.previewTitle,
			token = ++this.previewToken,
			store = new HiveStore({wiki: this.wiki}),
			tiddler = this.wiki.getTiddler(title);
		this.revokeImage();
		function info(text) {
			if(token === self.previewToken && self.infoNode) {
				self.infoNode.textContent = text;
			}
		}
		if(!tiddler || !util.isImageTiddler(tiddler)) {
			return info(title + ": not an image tiddler");
		}
		var text = String(tiddler.fields.text || ""),
			url = tiddler.fields[util.IMAGE_URL_FIELD];
		if(!text) {
		// The tiddler holds the hosted copy only, for example because it
		// was loaded from the chain
			return info(url ? (title + ": hosted copy only, " + this.previewDest + " copy is empty") : (title + ": no image data"));
		}
		var settings = util.getImageSettings(tiddler,store.getImageDefaults()),
			options = this.previewDest === "chain" ? settings.chain : settings.cdn;
		util.transformImage(text,tiddler.fields.type,options,function(err,transformed) {
			if(err) {
				return info(title + ": cannot be transformed (" + err + ")");
			}
			if(token !== self.previewToken) {
				return;
			}
			var resultType = transformed.type || tiddler.fields.type,
				kB = function(chars) {
					// base64 is 4 characters per 3 bytes
					return (chars * 0.75 / 1024).toFixed(chars * 0.75 >= 102400 ? 0 : 1);
				},
				label;
			if(self.previewDest === "chain") {
				var parts = Math.ceil(transformed.text.length / store.MAX_TEXT_LENGTH) || 1;
				label = transformed.changed ? "copy: " : "kept as is: ";
				label += transformed.width + "\u00d7" + transformed.height + ", " + kB(transformed.text.length) + " kB, " + parts + " part(s) on the chain";
			} else {
				label = (transformed.changed ? "upload: " : "uploads as is: ") +
					(transformed.width ? transformed.width + "\u00d7" + transformed.height + ", " : "") +
					kB(transformed.text.length) + " kB";
			}
			info(label);
			// Show the resulting image below the information line
			try {
				var bytes = util.decodeBase64(transformed.text),
					blob = new Blob([bytes],{type: resultType}),
					objectUrl = URL.createObjectURL(blob),
					image = self.document.createElement("img");
				self.previewObjectUrl = objectUrl;
				image.className = "hive-imagepreview-image";
				image.title = title;
				image.style.cssText = "max-width:96px;max-height:96px;display:block;margin:0.25em auto;";
				image.onload = function() {
					if(token !== self.previewToken) {
						URL.revokeObjectURL(objectUrl);
					}
				};
				image.src = objectUrl;
				self.domNode.insertBefore(image,self.infoNode);
			} catch(e) {
				info(label + " (the image cannot be shown: " + e.message + ")");
			}
		});
	};

	/*
Revoke the object url of the previous preview image, if any
	*/
	HiveImagePreviewWidget.prototype.revokeImage = function() {
		if(this.previewObjectUrl) {
			URL.revokeObjectURL(this.previewObjectUrl);
			this.previewObjectUrl = null;
		}
	};

	/*
Revoke the object url of the preview image when the widget is destroyed
	*/
	HiveImagePreviewWidget.prototype.onDestroy = function() {
		this.revokeImage();
	};

	exports["hive-imagepreview"] = HiveImagePreviewWidget;

})();

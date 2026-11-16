/*\
title: $:/plugins/tiddlywiki/hive/hive-imagepreview.js
type: application/javascript
module-type: widget

Preview widget for the copies of an image that a save to Hive publishes.
It shows the source of the image next to the copy that results from the
image settings of the tiddler, so that the loss of quality can be judged,
and it shows how large the copy is before anything is uploaded: the size
of the upload to the image hoster of Hive, and for the on-chain copy the
number of parts that are posted and the share of the Hive Power (resource
credits) that the copy is estimated to cost. Clicking a preview image
opens it fullscreen, so that the difference between the copies can be
examined closely.

The source is the image data that the tiddler holds: when the image was
added to the wiki, the source is the original, and once the wiki has been
reloaded from the chain, the source is the copy that is published there.
A copy is never the source of the other automatically, the image manager
has actions to adopt the hosted copy as the source.

Usage:

	<$hive-imagepreview title="My image.webp" dest="cdn"/>
	<$hive-imagepreview title="My image.webp" dest="chain"/>

The dest attribute selects the copy: "cdn" is the hosted copy that is
uploaded to images.hive.blog, "chain" is the copy that is stored inside the
replies of the wiki. Without a dest the hosted copy is shown. The optional
size attribute gives the largest side of a preview image in pixels
(default 150). The widget updates itself when the tiddler or its image
settings change.

\*/
(function(){

	/*jslint node: true, browser: true */
	/*global $tw: false */
	"use strict";

	var Widget = require("$:/core/modules/widgets/widget.js").widget,
		HiveStore = require("$:/plugins/tiddlywiki/hive/hivestore.js").HiveStore,
		HiveApi = require("$:/plugins/tiddlywiki/hive/hiveapi.js").HiveApi,
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
		this.previewSize = Math.max(32,parseInt(this.getAttribute("size","150"),10) || 150);
		this.previewToken = 0;
		this.previewObjectUrls = [];
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
		// The container holds the thumbnails and the information line that
		// the computation fills in
		this.domNode = this.document.createElement("div");
		this.domNode.className = "hive-imagepreview";
		this.domNode.setAttribute("data-hive-dest",this.previewDest);
		this.domNode.style.cssText = "display:inline-block;vertical-align:top;margin:0.5em 1em 0.5em 0;text-align:center;";
		this.thumbsNode = this.document.createElement("span");
		this.thumbsNode.className = "hive-imagepreview-thumbs";
		this.thumbsNode.style.cssText = "display:flex;align-items:flex-start;justify-content:center;gap:0.75em;";
		this.domNode.appendChild(this.thumbsNode);
		this.infoNode = this.document.createElement("span");
		this.infoNode.className = "hive-imagepreview-info";
		this.infoNode.style.cssText = "display:block;font-size:0.85em;color:#444;margin-top:0.4em;white-space:nowrap;";
		this.infoNode.textContent = "preparing ...";
		this.domNode.appendChild(this.infoNode);
		parent.insertBefore(this.domNode,nextSibling);
		this.domNodes.push(this.domNode);
		this.renderChildren(this.domNode,null);
		this.compute();
	};

	/*
Create one thumbnail with a caption below it and append it to the row of
thumbnails. The image opens fullscreen when it is clicked. Returns the
img element
	*/
	HiveImagePreviewWidget.prototype.addThumbnail = function(objectUrl,caption,captionClass) {
		var self = this,
			thumb = this.document.createElement("span"),
			image = this.document.createElement("img"),
			label = this.document.createElement("span");
		thumb.style.cssText = "display:inline-block;";
		image.className = "hive-imagepreview-image";
		image.title = this.previewTitle;
		image.alt = caption;
		image.style.cssText = "max-width:" + this.previewSize + "px;max-height:" + this.previewSize + "px;display:block;margin:0 auto;border:1px solid #ccc;background:#fafafa;cursor:zoom-in;";
		image.src = objectUrl;
		image.addEventListener("click",function() {
			self.openLightbox(objectUrl);
		});
		label.className = captionClass || "hive-imagepreview-caption";
		label.style.cssText = "display:block;font-size:0.8em;color:#666;margin-top:0.2em;";
		label.textContent = caption;
		thumb.appendChild(image);
		thumb.appendChild(label);
		this.thumbsNode.appendChild(thumb);
		return image;
	};

	/*
Show an image fullscreen until it is clicked again or Escape is pressed
	*/
	HiveImagePreviewWidget.prototype.openLightbox = function(objectUrl) {
		var self = this,
			doc = this.document;
		this.closeLightbox();
		var overlay = doc.createElement("div"),
			image = doc.createElement("img");
		overlay.className = "hive-imagepreview-lightbox";
		overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:zoom-out;";
		image.src = objectUrl;
		image.style.cssText = "max-width:92vw;max-height:92vh;background:transparent;";
		overlay.appendChild(image);
		var close = function() {
			self.closeLightbox();
		};
		var onKey = function(event) {
			if(event.key === "Escape") {
				close();
			}
		};
		overlay.addEventListener("click",close);
		doc.addEventListener("keydown",onKey,true);
		doc.body.appendChild(overlay);
		this.lightboxNode = overlay;
		this.lightboxKeyHandler = onKey;
	};

	/*
Close the fullscreen view of a preview image
	*/
	HiveImagePreviewWidget.prototype.closeLightbox = function() {
		if(this.lightboxKeyHandler) {
			this.document.removeEventListener("keydown",this.lightboxKeyHandler,true);
			this.lightboxKeyHandler = null;
		}
		if(this.lightboxNode && this.lightboxNode.parentNode) {
			this.lightboxNode.parentNode.removeChild(this.lightboxNode);
		}
		this.lightboxNode = null;
	};

	/*
Make an object url of the given base64 text of an image, or null when the
text cannot be decoded. The url is registered for the cleanup
	*/
	HiveImagePreviewWidget.prototype.makeObjectUrl = function(text,type) {
		try {
			var bytes = util.decodeBase64(text),
				objectUrl = URL.createObjectURL(new Blob([bytes],{type: type || "application/octet-stream"}));
			this.previewObjectUrls.push(objectUrl);
			return objectUrl;
		} catch(e) {
			return null;
		}
	};

	/*
Revoke the object urls of the previous preview images
	*/
	HiveImagePreviewWidget.prototype.revokeImage = function() {
		this.previewObjectUrls.forEach(function(objectUrl) {
			URL.revokeObjectURL(objectUrl);
		});
		this.previewObjectUrls = [];
	};

	/*
Compute the copy of the image that this preview shows and fill in the
thumbnails and the information line
	*/
	HiveImagePreviewWidget.prototype.compute = function() {
		var self = this,
			title = this.previewTitle,
			token = ++this.previewToken,
			store = new HiveStore({wiki: this.wiki}),
			tiddler = this.wiki.getTiddler(title);
		// The store of the preview shares one api object with the other
		// previews, so that the resource data of the chain is fetched
		// once and cached for all of them. Tests can inject a mock api
		// into $tw.hiveApi
		if(!store.api) {
			var config = store.getConfig();
			$tw.hiveApi = $tw.hiveApi || new HiveApi({rpc: config.rpc});
			store.api = $tw.hiveApi;
		}
		this.revokeImage();
		this.previewObjectUrls = [];
		function info(text,important) {
			if(token === self.previewToken && self.infoNode) {
				self.infoNode.textContent = text;
				self.infoNode.style.color = important ? "#a33" : "#444";
			}
		}
		if(!tiddler || !util.isImageTiddler(tiddler)) {
			return info(title + ": not an image tiddler");
		}
		var text = String(tiddler.fields.text || ""),
			url = tiddler.fields[util.IMAGE_URL_FIELD],
			type = tiddler.fields.type;
		if(!text) {
		// The tiddler holds the hosted copy only, for example because it
		// was loaded from the chain
			return info(url ? (title + ": hosted copy only, the " + this.previewDest + " copy is empty") : (title + ": no image data"));
		}
		// The original is always shown, so that the copy can be compared
		// with it. The source of the image is named after what it holds:
		// the copy that is published on the chain, or just the data that
		// the tiddler was added with
		var originalUrl = this.makeObjectUrl(text,type),
			originalChars = text.length,
			sourceCaption = "source";
		if(tiddler.fields[util.IMAGE_CHAIN_HASH_FIELD] && tiddler.fields[util.IMAGE_CHAIN_HASH_FIELD] === util.hashString(text)) {
			sourceCaption = "source (the on-chain copy)";
		}
		if(originalUrl) {
			this.addThumbnail(originalUrl,sourceCaption);
		}
		var settings = util.getImageSettings(tiddler,store.getImageDefaults()),
			options = this.previewDest === "chain" ? settings.chain : settings.cdn,
			caption = this.previewDest === "chain" ? "on-chain copy" : "hosted copy";
		util.transformImage(text,type,options,async function(err,transformed) {
			if(err) {
				return info(title + ": cannot be transformed (" + err + ")",true);
			}
			if(token !== self.previewToken) {
				return;
			}
			var resultType = transformed.type || type,
				// base64 is 4 characters per 3 bytes
				kB = function(chars) {
					return (chars * 0.75 / 1024).toFixed(chars * 0.75 >= 102400 ? 0 : 1);
				},
				saved = originalChars > 0 ? Math.round(100 * (1 - transformed.text.length / originalChars)) : 0,
				comparison = transformed.changed ? ", " + (saved > 0 ? "\u2212" + saved + "%" : "+" + (-saved) + "%") + " (" + kB(originalChars) + " kB source)" : "",
				// The bytes of the operations are counted directly, unlike
				// the base64 characters of the image data
				kBp = function(bytes) {
					return (bytes / 1024).toFixed(bytes >= 102400 ? 0 : 1);
				};
			// The dimensions of a copy that is kept as it is are read from
			// the image itself, the fast path of the transform does not
			// report them
			var estimate = null;
			if(self.previewDest === "chain") {
				estimate = self.estimateChainCost(store,tiddler,transformed);
			}
			// The wording of the share of the available Hive Power: the
			// live estimate of the chain has no note, the measurement of
			// the last save says where it comes from
			var rcSegment = function(share) {
				var note = share.source === "measured" ? " (measured at the last save)" : "";
				return share.tooMuch ?
					(", \u2248 " + share.percent + "% of the available Hive Power" + note + ": the save will be stopped, scale this copy down") :
					(", \u2248 " + share.percent + "% of the available Hive Power" + note);
			};
			var finish = function(dims) {
				if(token !== self.previewToken) {
					return;
				}
				var label,
					tooMuch = false;
				if(self.previewDest === "chain" && estimate) {
					var rc = self.estimateRcShare(store,estimate.bytes);
					label = (transformed.changed ? "copy: " : "kept as is: ") +
						(dims ? dims.width + "\u00d7" + dims.height + ", " : "") + kB(transformed.text.length) + " kB" + comparison +
						", " + estimate.parts + " part(s) \u2248 " + kBp(estimate.bytes) + " kB posted";
					if(rc !== null) {
						tooMuch = rc.tooMuch;
						label += rcSegment({source: "measured",percent: rc.percent,tooMuch: rc.tooMuch});
					}
				} else {
					label = (transformed.changed ? "upload: " : "uploads as is: ") +
						(dims ? dims.width + "\u00d7" + dims.height + ", " : "") +
						kB(transformed.text.length) + " kB" + comparison;
				}
				// The copy is only shown next to the original when it
				// differs from it, otherwise the original alone is the
				// preview and its caption names the copy that is published
				if(transformed.changed) {
					var resultUrl = self.makeObjectUrl(transformed.text,resultType);
					if(resultUrl) {
						self.addThumbnail(resultUrl,caption);
					} else {
						info(label + " (the copy cannot be shown)",true);
						return;
					}
				} else if(originalUrl) {
					var captions = self.thumbsNode.querySelectorAll(".hive-imagepreview-caption");
					if(captions.length) {
						captions[0].textContent = caption;
					}
				}
				info(label,tooMuch);
				if(self.previewDest === "chain" && estimate) {
				// The live estimate of the chain replaces the measurement
				// of the last save as soon as it is readable, because it
				// does not need a previous save of this app
					var config = store.getConfig();
					store.getRcShare(config,estimate.operations,function(err,share) {
						if(!err && share && share.source === "curve" && token === self.previewToken) {
							var liveLabel = /, \u2248 [0-9]+% of the available Hive Power/.test(label) ?
								label.replace(/, \u2248 [0-9]+% of the available Hive Power.*$/,rcSegment(share)) :
								label + rcSegment(share);
							info(liveLabel,share.tooMuch);
						}
					});
				}
			};
			if(transformed.width) {
				finish({width: transformed.width,height: transformed.height});
			} else {
				try {
					var bitmap = await createImageBitmap(new Blob([util.decodeBase64(transformed.text)],{type: resultType}));
					var dims = {width: bitmap.width,height: bitmap.height};
					bitmap.close();
					finish(dims);
				} catch(e) {
					finish(null);
				}
			}
		});
	};

	/*
Estimate the size of the operations that a save broadcasts for the given
transformed copy of the image: the payload is split into the parts that
fit into a reply, and each part is broadcast as its own transaction. The
callback is not needed, the estimate is synchronous. Returns an object
with the number of parts, the total number of bytes of the operations and
the operations themselves, for the live estimate of the resource credits
	*/
	HiveImagePreviewWidget.prototype.estimateChainCost = function(store,tiddler,transformed) {
		var payload = util.getTiddlerPayload(tiddler);
		payload.text = transformed.text;
		payload.fields = $tw.utils.extend({},payload.fields);
		if(transformed.changed) {
		// The same fields that prepareImagePayloads stores with the copy
			payload.fields[util.IMAGE_SRC_HASH_FIELD] = util.hashString(String(tiddler.fields.text || ""));
			payload.fields[util.IMAGE_CHAIN_HASH_FIELD] = util.hashString(transformed.text);
			payload.fields.type = transformed.type || tiddler.fields.type;
		}
		var parts = store.splitPayload(payload),
			bytes = 0,
			operations = [];
		parts.forEach(function(part,index) {
			var operation = {
				type: "comment",
				parent_author: "account",
				parent_permlink: "tw5-root-0000000000000000",
				author: "account",
				permlink: "tw5-image-0000000000000000-" + index,
				title: payload.title,
				body: "![" + payload.title + "](url)",
				json_metadata: JSON.stringify({app: "tw5",tw5: part})
			};
			bytes += util.getOperationSize(operation);
			operations.push(operation);
		});
		return {parts: parts.length || 1,bytes: bytes,operations: operations};
	};

	/*
Estimate the share of the available Hive Power that the given number of
bytes of operations cost, from the measurement of the last save. Returns
null when no measurement is known, otherwise an object with the percent
of the credits that are left and whether it exceeds the limit at which a
save is stopped
	*/
	HiveImagePreviewWidget.prototype.estimateRcShare = function(store,bytes) {
		var state = store.getRemoteState() || {};
		if(!state.rcPerByte || !state.rc || !state.rc.current) {
			return null;
		}
		var percent = Math.round(100 * state.rcPerByte * bytes / state.rc.current);
		return {
			source: "measured",
			percent: percent,
			tooMuch: percent >= 95
		};
	};

	/*
Revoke the object urls of the preview images and close the fullscreen
view when the widget is destroyed
	*/
	HiveImagePreviewWidget.prototype.onDestroy = function() {
		this.closeLightbox();
		this.revokeImage();
	};

	exports["hive-imagepreview"] = HiveImagePreviewWidget;

})();

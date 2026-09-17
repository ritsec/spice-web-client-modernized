/*
 eyeOS Spice Web Client
Copyright (c) 2015 eyeOS S.L.

Contact Jose Carlos Norte (jose@eyeos.com) for more information about this software.

This program is free software; you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License version 3 as published by the
Free Software Foundation.
 
This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more
details.
 
You should have received a copy of the GNU Affero General Public License
version 3 along with this program in the file "LICENSE".  If not, see 
<http://www.gnu.org/licenses/agpl-3.0.txt>.
 
See www.eyeos.org for more details. All requests should be sent to licensing@eyeos.org
 
The interactive user interfaces in modified source and object code versions
of this program must display Appropriate Legal Notices, as required under
Section 5 of the GNU Affero General Public License version 3.
 
In accordance with Section 7(b) of the GNU Affero General Public License version 3,
these Appropriate Legal Notices must retain the display of the "Powered by
eyeos" logo and retain the original copyright notice. If the display of the 
logo is not reasonably feasible for technical reasons, the Appropriate Legal Notices
must display the words "Powered by eyeos" and retain the original copyright notice. 
 */

wdi.AsyncConsumer = $.spcExtend(wdi.EventObject.prototype, {
	worker: null,
	task: null,
	packetWorkerIdentifier: null,
	imageProperties: null,
	decodeStart: null,

	init: function(c) {
		this.superInit();
		this.worker = c.AsyncWorker || new wdi.AsyncWorker({script:'application/WorkerProcess.js'});
		this.packetWorkerIdentifier = c.packetWorkerIdentifier || new wdi.PacketWorkerIdentifier();
	},

	consume: function(task) {
		this.task = task; //store current task
		var message = task.message;
		var imageProperties;

		//check if the packet is a type of packet that should be intercepted
		//this doesn't mean it contains a compressed image, it means that it COULD
		var intercept = this.packetWorkerIdentifier.shouldUseWorker(message);

		if(intercept == wdi.PacketWorkerIdentifier.processingType.DECOMPRESS) {
			//get image properties to check if there is really a compressed image
			imageProperties = this.packetWorkerIdentifier.getImageProperties(message);
			this.imageProperties = imageProperties;
			if(!imageProperties || !this.canDecodeInWorker(message, imageProperties.descriptor)) {
				intercept = 0;
			}
		}

		//the packet is not going to be intercepted by the worker thread.
		//mark as procssed.
		if(intercept === 0) {
			this.taskDone();
			return;
		}

		var data;
		var descriptor;
		var opaque;
		var brush;
		var ret;
		var arr;
		var u8;

		if(intercept == wdi.PacketWorkerIdentifier.processingType.DECOMPRESS) {
			this.decodeStart = wdi.NetStats.enabled ? wdi.NetStats.now() : null;
			data = imageProperties.data;
			descriptor = imageProperties.descriptor;
			opaque = imageProperties.opaque;
			brush = imageProperties.brush;

			if(descriptor.type === wdi.SpiceImageType.SPICE_IMAGE_TYPE_LZ_RGB) {
				var header = null;

				if(!brush) { //brushes are still js arrays
					var headerData = data.subarray(0,32).toJSArray();
					data = data.subarray(32); //skip the header
					header = wdi.LZSS.demarshall_rgb(headerData);
				} else {
					header = wdi.LZSS.demarshall_rgb(data);
				}



				arr = new ArrayBuffer(data.length+16);
				u8 = new Uint8Array(arr);

				u8[0] = 1; //LZ_RGB
				u8[1] = opaque;
				u8[2] = header.type;
				u8[3] = header.top_down; //RESERVED

				var number = header.width * header.height * 4;

				for (var i = 0;i < 4;i++) {//iterations because of javascript number size
					u8[4+i] = number & (255);//Get only the last byte
					number = number >> 8;//Remove the last byte
				}
				var view = new DataView(arr);
				view.setUint32(8, header.width);
				view.setUint32(12, header.height);
				u8.set(data, 16);

				//intercept
				//var encoded = encodeURIComponent(Base64.encode(u8.toJSArray()));
				//$.post('record.php','data='+encoded+'&name=lz_rgba_'+encoded.length+'_'+descriptor.width+'x'+descriptor.height);

				this.worker.run(arr, this._workerCompleted, {type: 'lz',top_down: header.top_down, opaque: opaque}, this);
			} else if(descriptor.type === wdi.SpiceImageType.SPICE_IMAGE_TYPE_QUIC) {
				var adata = new ArrayBuffer(data.length+4);
				var view = new Uint8Array(adata);
				view.set(data, 4);
				view[1] = opaque?1:0;
				view[0] = 0; //quic

				//intercept
				/*
				var jsarray = new Uint8Array(adata);
				var encoded = encodeURIComponent(Base64.encode(jsarray.toJSArray()));
				var dateat = Date.now() /1000;
				$.post('record.php','data='+encoded+'&name=quic_'+encoded.length+'_'+descriptor.width+'x'+descriptor.height);
				*/

				this.worker.run(adata, this._workerCompleted, {type: 'quic'}, this);
			} else {
				// JPEG or JPEG_ALPHA. The JPEG data starts after a 4 or 9 byte header, as in graphic.js.
				var jpeg = data.subarray(descriptor.type === wdi.SpiceImageType.SPICE_IMAGE_TYPE_JPEG ? 4 : 9);
				arr = new ArrayBuffer(jpeg.length + 4);
				u8 = new Uint8Array(arr);
				u8[0] = wdi.AsyncConsumer.IMAGE_BITMAP_OPERATION;
				u8.set(jpeg, 4);
				this.worker.run(arr, this._workerCompleted, {type: 'bitmap'}, this);
			}
		} else if(intercept == wdi.PacketWorkerIdentifier.processingType.PROCESSVIDEO) {
			// MJPEG stream frame. If the worker can't decode it, handleStreamData falls back to <img>.
			data = this.packetWorkerIdentifier.getVideoData(message);
			arr = new ArrayBuffer(data.length+4);
			u8 = new Uint8Array(arr);
			u8[0] = wdi.AsyncConsumer.IMAGE_BITMAP_OPERATION;
			u8.set(data, 4);
			this.worker.run(arr, function(bitmap) {
				if (bitmap) {
					message.args.data = bitmap;
				}
				this.taskDone();
			}, null, this);
		}
	},

	// QUIC and LZ always decode in the worker. JPEG decodes there with createImageBitmap,
	// but only for plain copies that skip the image cache: raster ops and the cache
	// still expect a canvas or ImageData.
	canDecodeInWorker: function(message, descriptor) {
		var types = wdi.SpiceImageType;
		if (descriptor.type === types.SPICE_IMAGE_TYPE_LZ_RGB || descriptor.type === types.SPICE_IMAGE_TYPE_QUIC) {
			return true;
		}
		return (descriptor.type === types.SPICE_IMAGE_TYPE_JPEG || descriptor.type === types.SPICE_IMAGE_TYPE_JPEG_ALPHA) &&
			wdi.AsyncConsumer.bitmapsSupported &&
			message.messageType === wdi.SpiceVars.SPICE_MSG_DISPLAY_DRAW_COPY &&
			message.args.rop_descriptor === wdi.SpiceRopd.SPICE_ROPD_OP_PUT &&
			!(descriptor.flags & wdi.SpiceImageFlags.SPICE_IMAGE_FLAGS_CACHE_ME);
	},

	//executed from webworker when processing is finished
	_workerCompleted: function(buf, options) {
		if (wdi.NetStats.enabled && this.decodeStart !== null) {
			wdi.NetStats.recordDecode(this.task.message, wdi.NetStats.now() - this.decodeStart,
				this.imageProperties.descriptor.width * this.imageProperties.descriptor.height);
			this.decodeStart = null;
		}
		if(!buf) {
			this.taskDone();
			return;
		}
		var descriptor = this.imageProperties.descriptor;
		// The worker returns an ImageBitmap for JPEG and top-down RGBA pixels for QUIC and LZ.
		var myImage = options.type === 'bitmap' ? buf :
			new ImageData(new Uint8ClampedArray(buf), descriptor.width, descriptor.height);

		descriptor.originalType = descriptor.type;
		descriptor.type = wdi.SpiceImageType.SPICE_IMAGE_TYPE_CANVAS;

		//replace data
		if(this.task.message.messageType === wdi.SpiceVars.SPICE_MSG_DISPLAY_DRAW_FILL) {
			this.task.message.args.brush.pattern.imageData = myImage;
			this.task.message.args.brush.pattern.image.type = wdi.SpiceImageType.SPICE_IMAGE_TYPE_CANVAS;
		} else {
			this.task.message.args.image.data = myImage;
		}
		this.taskDone();
	},
	
	taskDone: function() {
		this.task.state = 1;
		this.fire('done', this);
	},

	dispose: function () {
		this.worker.dispose();
	}
});

wdi.AsyncConsumer.IMAGE_BITMAP_OPERATION = 4; // wdi.WorkerOperations.imageBitmap in WorkerProcess.js
wdi.AsyncConsumer.bitmapsSupported = typeof createImageBitmap === 'function';

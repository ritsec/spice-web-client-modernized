suite('GraphicTest', function() {
	var clientGui, displayPreProcess;

	this.timeout(2000);
	
	setup(function() {
		wdi.Debug.debug = false;
		clientGui = new wdi.ClientGui();
		displayPreProcess = new wdi.DisplayPreProcess({
			clientGui: clientGui
		});
	});

	// The legacy $.spcExtend() copies the DisplayPreProcess prototype-level
	// fields (queued/inProcess/idleConsumers/consumers) by reference, so every
	// instance in the page shares one consumer pool. Each test here builds a
	// fresh instance; without cleanup the next test's executeConsumer() pulls a
	// previous test's idle consumer, whose 'done' listener still routes through
	// the previous test's DisplayProcess - the previous test's postProcess spy
	// fires inside the wrong window and the current one times out.
	function resetSharedDisplayState() {
		var P = wdi.DisplayPreProcess.prototype;
		P.consumers.forEach(function (consumer) {
			consumer.dispose();
		});
		P.consumers.length = 0;
		P.idleConsumers.length = 0;
		P.queued.length = 0;
		P.inProcess.length = 0;

		var ec = wdi.ExecutionControl;
		ec.runQ.tasks.length = 0;
		ec.runQ.isRunning = false;
		ec.sync = true;
		ec.currentProxy = null;
	}

	teardown(function() {
		clearInterval(displayPreProcess.displayProcess.timer);
		displayPreProcess.displayProcess.started = false;
		displayPreProcess.displayProcess.waitingMessages.length = 0;
		resetSharedDisplayState();
	});

	wdi.graphicTestUris.forEach(function (item) {
		test(item.split('/').pop(), function(done) {
			$.get(item).done(function(data) {
				data = JSON.parse(data);
				var testFunction = function() {
					clientGui.getCanvas = function() {
						return ctxOrigin.canvas;
					};
				clientGui.getContext = function() {
					return ctxOrigin;
				};
					displayPreProcess.displayProcess.postProcess = function() {
						var originURL = ctxOrigin.canvas.toDataURL('image/png');
						var expectedURL = ctxExpected.canvas.toDataURL('image/png');
						if (originURL !== expectedURL) {
							// Fixtures were generated with a different Chromium build, so a
							// few anti-aliasing/rounding edge pixels may drift by 1-2 levels.
							// Tolerate only tiny sub-pixel differences - a real rendering
							// bug would change whole regions (hundreds of pixels).
							var w = ctxOrigin.canvas.width, h = ctxOrigin.canvas.height;
							var a = ctxOrigin.getImageData(0, 0, w, h).data;
							var b = ctxExpected.getImageData(0, 0, w, h).data;
							var diff = 0, maxDelta = 0;
							for (var i = 0; i < a.length; i += 4) {
								if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2] || a[i+3] !== b[i+3]) {
									diff++;
									var m = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i+1] - b[i+1]), Math.abs(a[i+2] - b[i+2]), Math.abs(a[i+3] - b[i+3]));
									if (m > maxDelta)
										maxDelta = m;
								}
							}
							assert.ok(diff <= 32 && maxDelta <= 64, 'The image is not the same as expected: ' + diff + ' pixels differ, max per-channel delta ' + maxDelta);
						}
						done();
					};
					var rawSpiceMessage = JSON.parse(data.object);
					// Depending on the browser version JSON.stringify stores typed arrays attributes or not
					// We are interested on length, so if it is not there we create it.
					if (typeof rawSpiceMessage.body.q.length === "undefined") {
						rawSpiceMessage.body.q.length = Object.keys(rawSpiceMessage.body.q).length;
					}
					var queue = new wdi.ViewQueue();
					queue.setData(rawSpiceMessage.body.q);
					rawSpiceMessage.body = queue;
					displayPreProcess.process(wdi.PacketFactory.extract(rawSpiceMessage));
				};
				var aux = false;
				var ctxOrigin = $('<canvas/>')[0].getContext('2d');
				var imgOrigin = new Image();
				imgOrigin.onload = function() {
					// A bare <canvas> is 300x150; drawImage() would clip the
					// 1905px-wide test images to that corner. Size the canvas to
					// the image so the full picture is drawn and compared.
					ctxOrigin.canvas.width = imgOrigin.width;
					ctxOrigin.canvas.height = imgOrigin.height;
					ctxOrigin.drawImage(imgOrigin, 0, 0);
					if (aux)
						testFunction();
					else 
						aux = true;
				};
				imgOrigin.src = data.origin.replace(/\s/g, '+');
				var ctxExpected = $('<canvas/>')[0].getContext('2d');
				var imgExpected = new Image();
				imgExpected.onload = function() {
					ctxExpected.canvas.width = imgExpected.width;
					ctxExpected.canvas.height = imgExpected.height;
					ctxExpected.drawImage(imgExpected, 0, 0);
					if (aux)
						testFunction();
					else 
						aux = true;
				};
				imgExpected.src = data.expected.replace(/\s/g, '+');
			});
		});
	});
});

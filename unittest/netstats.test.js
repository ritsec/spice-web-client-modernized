suite('NetStats', function() {
	var sut = wdi.NetStats;
	var time, originalNow;
	var DRAW_COPY = wdi.SpiceVars.SPICE_MSG_DISPLAY_DRAW_COPY;
	var SURFACE_CREATE = wdi.SpiceVars.SPICE_MSG_DISPLAY_SURFACE_CREATE;

	function drawPacket(box, imageType) {
		var args = {base: {surface_id: 0, box: box}};
		if (imageType !== undefined) {
			args.image = {imageDescriptor: {type: imageType}};
		}
		return {args: args};
	}

	function box(left, top, right, bottom) {
		return {left: left, top: top, right: right, bottom: bottom};
	}

	setup(function() {
		wdi.Debug.debug = false;
		originalNow = sut.now;
		time = 0;
		sut.now = function() {
			return time;
		};
		sut.stop();
		sut.surfaces = {};
		sut.arrivals = new WeakMap();
		sut.enabled = true;
		sut.reset();
	});

	teardown(function() {
		sut.stop();
		sut.surfaces = {};
		sut.arrivals = new WeakMap();
		sut.now = originalNow;
		sut.reset();
	});

	test('start turns stats on and stop turns them off', function() {
		sut.start(60000);
		assert.isTrue(sut.enabled);
		assert.isNotNull(sut.timer);
		sut.stop();
		assert.isFalse(sut.enabled);
		assert.isNull(sut.timer);
	});

	test('turns channel bytes into per-second rates', function() {
		sut.recordReceived(wdi.SpiceVars.SPICE_CHANNEL_DISPLAY, 60000);
		sut.recordReceived(wdi.SpiceVars.SPICE_CHANNEL_DISPLAY, 40000);
		sut.recordSent(wdi.SpiceVars.SPICE_CHANNEL_INPUTS, 2000);
		time = 2000;

		var channels = sut.getSnapshot().channels;
		var display = channels.filter(function(row) { return row.channel === 'display'; })[0];
		var inputs = channels.filter(function(row) { return row.channel === 'inputs'; })[0];

		assert.equal(display['recv kB/s'], 50);
		assert.equal(display['recv msg/s'], 1);
		assert.equal(inputs['sent kB/s'], 1);
	});

	test('labels draws by message and image type', function() {
		sut.recordDisplayMessage(DRAW_COPY, 5000, drawPacket(box(0, 0, 10, 10), wdi.SpiceImageType.SPICE_IMAGE_TYPE_LZ_RGB));

		var row = sut.getSnapshot().display[0];
		assert.equal(row.message, 'DRAW_COPY lz_rgb');
		assert.equal(row.count, 1);
		assert.equal(row.kB, 5);
	});

	test('marks messages the client could not decode', function() {
		sut.recordDisplayMessage(wdi.SpiceVars.SPICE_MSG_DISPLAY_DRAW_OPAQUE, 3000, undefined);

		assert.equal(sut.getSnapshot().display[0].message, 'DRAW_OPAQUE (not decoded)');
	});

	test('counts draws that cover the whole surface', function() {
		sut.recordDisplayMessage(SURFACE_CREATE, 20, {args: {surface_id: 0, width: 1920, height: 1080}});
		sut.recordDisplayMessage(DRAW_COPY, 30000, drawPacket(box(0, 0, 1920, 1080)));
		sut.recordDisplayMessage(DRAW_COPY, 10000, drawPacket(box(100, 100, 200, 200)));

		var fullSurface = sut.getSnapshot().fullSurface;
		assert.equal(fullSurface.count, 1);
		assert.equal(fullSurface.kB, 30);
		assert.equal(fullSurface['% of bytes'], 75);
	});

	test('learns surface sizes while stats are off', function() {
		sut.stop();
		sut.recordDisplayMessage(SURFACE_CREATE, 20, {args: {surface_id: 0, width: 800, height: 600}});
		sut.enabled = true;
		sut.reset();

		sut.recordDisplayMessage(DRAW_COPY, 1000, drawPacket(box(0, 0, 800, 600)));

		assert.equal(sut.getSnapshot().fullSurface.count, 1);
		assert.equal(sut.getSnapshot().display.length, 1, 'the surface message itself should not be counted');
	});

	test('measures the time from arrival to drawn', function() {
		var packet = drawPacket(box(0, 0, 10, 10));
		time = 100;
		sut.recordDisplayMessage(DRAW_COPY, 1000, packet);
		time = 130;
		sut.recordDrawDone(packet);

		var latency = sut.getSnapshot().latency;
		assert.equal(latency.count, 1);
		assert.equal(latency['p50 ms'], 30);
		assert.equal(latency['max ms'], 30);
	});

	test('counts dropped messages without adding latency samples', function() {
		var packet = drawPacket(box(0, 0, 10, 10));
		sut.recordDisplayMessage(DRAW_COPY, 4000, packet);
		sut.recordDropped(packet);
		sut.recordDrawDone(packet);

		var snapshot = sut.getSnapshot();
		assert.equal(snapshot.dropped.count, 1);
		assert.equal(snapshot.dropped.kB, 4);
		assert.equal(snapshot.latency.count, 0);
	});

	test('lists the rectangles with the most bytes first', function() {
		for (var i = 1; i <= 7; i++) {
			sut.recordDisplayMessage(DRAW_COPY, i * 1000, drawPacket(box(0, 0, i, i)));
		}

		var rects = sut.getSnapshot().rects;
		assert.equal(rects.length, sut.topRectCount);
		assert.equal(rects[0].rect, 's0 7x7 @0,0');
		assert.equal(rects[0].kB, 7);
	});

	test('reset clears counters but keeps surface sizes', function() {
		sut.recordDisplayMessage(SURFACE_CREATE, 20, {args: {surface_id: 0, width: 800, height: 600}});
		sut.recordReceived(wdi.SpiceVars.SPICE_CHANNEL_DISPLAY, 1000);
		sut.reset();

		var snapshot = sut.getSnapshot();
		assert.equal(snapshot.channels.length, 0);
		assert.equal(snapshot.display.length, 0);
		assert.deepEqual(sut.surfaces[0], {width: 800, height: 600});
	});

	test('counts deferred and fallback ACKs', function() {
		sut.recordAck(false);
		sut.recordAck(true);

		assert.deepEqual(sut.getSnapshot().acks, {count: 2, fallback: 1});
	});

	test('averages decode and draw times on the message row, including messages from before a reset', function() {
		var QUIC = wdi.SpiceImageType.SPICE_IMAGE_TYPE_QUIC;
		var early = drawPacket(box(0, 0, 10, 10), QUIC);
		sut.recordDisplayMessage(DRAW_COPY, 1000, early);
		sut.reset();
		var late = drawPacket(box(0, 0, 10, 10), QUIC);
		sut.recordDisplayMessage(DRAW_COPY, 1000, late);

		sut.recordDecode(early, 10, 1000000);
		sut.recordDecode(late, 30, 1000000);
		time = 100;
		sut.recordDrawStart(late);
		time = 104;
		sut.recordDrawDone(late);

		var row = sut.getSnapshot().display[0];
		assert.equal(row.message, 'DRAW_COPY quic');
		assert.equal(row.count, 1);
		assert.equal(row['decode ms'], 20);
		assert.equal(row['decode ms/MP'], 20);
		assert.equal(row['draw ms'], 4);
	});

	test('report prints everything as one console.log block', function() {
		sut.recordReceived(wdi.SpiceVars.SPICE_CHANNEL_DISPLAY, 1000);
		sut.recordDisplayMessage(DRAW_COPY, 1000, drawPacket(box(0, 0, 10, 10)));
		var log = sinon.stub(console, 'log');
		var table = sinon.stub(console, 'table');
		try {
			sut.report();
			assert.isTrue(log.calledOnce);
			var text = log.firstCall.args[0];
			assert.include(text, 'recv kB/s');
			assert.include(text, 'DRAW_COPY');
			assert.include(text, 'arrival->drawn');
			assert.isFalse(table.called);
		} finally {
			log.restore();
			table.restore();
		}
	});

	test('report prints one line when there was no traffic', function() {
		var log = sinon.stub(console, 'log');
		var table = sinon.stub(console, 'table');
		try {
			sut.report();
			assert.isTrue(log.calledOnce);
			assert.include(log.firstCall.args[0], 'no traffic');
			assert.isFalse(table.called);
		} finally {
			log.restore();
			table.restore();
		}
	});
});

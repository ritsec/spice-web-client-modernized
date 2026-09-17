suite("Image uncompressor suite", function () {
	var syncAsyncHandler, sut, clientGui, context, headerType,
		imageDescriptor, opaque, callback, scope;

	setup(function () {
		callback = function () {};
		scope = {};

		opaque = 1;

		headerType = 1;

		imageDescriptor = {
			type: wdi.SpiceImageType.SPICE_IMAGE_TYPE_LZ_RGB,
			width: 10,
			height: 10
		};

		var context = window.$('<canvas>')[0].getContext('2d');
		clientGui = {
			getContext: function (pos) {
				return context;
			}
		};
		syncAsyncHandler = {
			dispatch: function () {}
		};
		sut = new wdi.ImageUncompressor({syncAsyncHandler: syncAsyncHandler});
	});

	teardown(function () {

	});

	test.skip('processLz calls syncAsyncHandler.dispatch', sinon.test(function() {
		var stub = stubSyncAsync(this);
		var demarshallStub = stubDemarshall(this);

		var imageData = [1,2,3];

		var bufferData = [1,2,3];
		var buffer = new ArrayBuffer(bufferData.length + 8);
		u8 = new Uint8Array(buffer);

		u8[0] = 1; //LZ_RGB
		u8[1] = opaque;
		u8[2] = headerType;
		u8[3] = 0; //padding

		u8[4] = 144;
		u8[5] = 1;
		u8[6] = 0;
		u8[7] = 0;

		u8.set(bufferData, 8);

		var brush = true;

		sut.processLz(imageData, brush, opaque, clientGui, callback, scope);

		sinon.assert.calledWithExactly(stub, buffer, callback, scope);
	}));

	function stubDemarshall(self) {
		return self.stub(wdi.LZSS, 'demarshall_rgb').returns({
			type: headerType,
			width: 10,
			height: 10
		});
	}

	function stubSyncAsync(self) {
		return self.stub(syncAsyncHandler, 'dispatch');
	}

	test('processLz calls LZSS.demarshall_rgb when brush', sinon.test(function () {
		var dispatchStub = stubSyncAsync(this);
		var stub = stubDemarshall(this);

		var imageData = [1,2,3];

		var brush = true;

		sut.processLz(imageData, brush, opaque, clientGui, callback, scope);

		sinon.assert.calledWithExactly(stub, imageData);
	}));

	test('processLz calls LZSS.demarshall_rgb when no brush and imageData is array', sinon.test(function () {
		var dispatchStub = stubSyncAsync(this);
		var stub = stubDemarshall(this);

		var imageData = [];
		imageData.length = 32;
		imageData.push(1);
		imageData.push(2);
		imageData.push(3);

		expectedData = [];
		expectedData.length = 32;

		var brush = false;

		sut.processLz(imageData, brush, opaque, clientGui, callback, scope);

		sinon.assert.calledWithExactly(stub, expectedData);
	}));

	test('processLz calls LZSS.demarshall_rgb when no brush and imageData is typedArray', sinon.test(function () {
		var dispatchStub = stubSyncAsync(this);
		var stub = stubDemarshall(this);

		var buffer = new ArrayBuffer(35);
		u8ImageData = new Uint8Array(buffer);

		var expectedData = [0,0,0,0,0,0,0,0,
							0,0,0,0,0,0,0,0,
							0,0,0,0,0,0,0,0,
							0,0,0,0,0,0,0,0];

		var brush = false;

		sut.processLz(u8ImageData, brush, opaque, clientGui, callback, scope);

		sinon.assert.calledWithExactly(stub, expectedData);
	}));

	function quicTestOpaque (opaque, self) {
		var obtainedBuff;
		var dispatchStub = self.stub(syncAsyncHandler, 'dispatch', function (buff) {
			obtainedBuff = buff;
		});

		var imageData = [];

		var buffer = new ArrayBuffer(4);
		var view = new Uint8Array(buffer);

		view[3] = opaque ? 1 : 0;
		view[0] = 0; //quic
		sut.processQuic(imageData, opaque, clientGui, callback, scope);

		sinon.assert.calledWithExactly(dispatchStub, buffer, callback, scope);

		// sinon.deepEqual cannot acces the data inside the arrayBuffer
		// so we check also the data.
		var obtainedView = new Uint8Array(obtainedBuff);
		assert.deepEqual(view, obtainedView, "The data inside the buffer does not match");
	}

	test('processQuic calls syncAsyncHandler.dispatch with opaque', sinon.test(function () {
		opaque = true;
		quicTestOpaque(opaque, this);
	}));

	test('processQuic calls syncAsyncHandler.dispatch without opaque', sinon.test(function () {
		opaque = false;
		quicTestOpaque(opaque, this);
	}));

	test('process calls processQuic when image is quic', sinon.test(function () {
		var stub = this.stub(sut, 'processQuic');

		var imageData = [], brush = 1;

		imageDescriptor.type = wdi.SpiceImageType.SPICE_IMAGE_TYPE_QUIC;

		sut.process(imageDescriptor, imageData, brush, opaque, clientGui, callback, scope);

		sinon.assert.calledWithExactly(stub, imageData, opaque, clientGui, callback, scope);
	}));

	test('process calls processLz when image is lz', sinon.test(function () {
		var stub = this.stub(sut, 'processLz');

		var imageData = [], brush = 1;

		imageDescriptor.type = wdi.SpiceImageType.SPICE_IMAGE_TYPE_LZ_RGB;

		sut.process(imageDescriptor, imageData, brush, opaque, clientGui, callback, scope);

		sinon.assert.calledWithExactly(stub, imageData, brush, opaque, clientGui, callback, scope);
	}));

	test('extractLzHeader returns an imagedata with the header extracted when no brush', sinon.test(function() {
		var brush = false;
		var expected = 123;
		var imageData = [];
		imageData.length = sut.lzHeaderSize;
		imageData.push(expected);
		var result = sut.extractLzHeader(imageData, brush);
		assert.equal(result.imageData[0], expected, "header not extracted correctly from imageData");
	}));
});

suite('wdi.flipImageRows', function() {
	test('reverses row order in place for odd and even heights', function() {
		var rows = function(values) {
			return new Uint8Array(values.reduce(function(all, value) {
				return all.concat([value, value, value, value]);
			}, [])).buffer;
		};
		var firstChannel = function(buffer) {
			return Array.prototype.filter.call(new Uint8Array(buffer), function(value, i) {
				return i % 4 === 0;
			});
		};

		var odd = rows([1, 2, 3]);
		wdi.flipImageRows(odd, 1, 3);
		assert.deepEqual(firstChannel(odd), [3, 2, 1]);

		var even = rows([1, 2, 3, 4]);
		wdi.flipImageRows(even, 1, 4);
		assert.deepEqual(firstChannel(even), [4, 3, 2, 1]);
	});
});

suite('workerDispatch LZ', function() {
	test('flips only images that are neither opaque nor top-down', function() {
		// Two 1-pixel rows whose first bytes are 1 and 2, as the decoder would return them.
		var decode = sinon.stub(wdi.LZSS, 'lz_rgb32_decompress_rgb', function() {
			return new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2]).buffer;
		});
		var firstRow = function(opaque, topDown) {
			var arr = new ArrayBuffer(16);
			var u8 = new Uint8Array(arr);
			u8[0] = wdi.WorkerOperations.lz_rgb;
			u8[1] = opaque;
			u8[3] = topDown;
			new DataView(arr).setUint32(8, 1);
			new DataView(arr).setUint32(12, 2);
			return new Uint8Array(window.workerDispatch(arr, false))[0];
		};
		try {
			assert.equal(firstRow(0, 0), 2, 'non-opaque bottom-up image should be flipped');
			assert.equal(firstRow(0, 1), 1, 'top-down image should not be flipped');
			assert.equal(firstRow(1, 0), 1, 'opaque images are reversed by the decoder itself');
		} finally {
			decode.restore();
		}
	});
});

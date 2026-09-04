suite("Keymap", function() {
	var sut;

	setup(function () {
		sut = wdi.Keymap;
	});

	suite('#handledByCharmap', function () {
		test('return true when type is inputmanager', function () {
			assert.isTrue(sut.handledByCharmap('inputmanager'));
		});

		test('return false when type is not inputmanager', function () {
			assert.isFalse(sut.handledByCharmap('fakeEvent'));
		});
	});

	suite('#defaultCodes', function () {
		test('maps KeyA to its scan code', function () {
			assert.deepEqual(sut.defaultCodes['KeyA'], [0x1E, 0, 0, 0]);
		});
		test('maps Digit0 to its scan code', function () {
			assert.deepEqual(sut.defaultCodes['Digit0'], [0x0B, 0, 0, 0]);
		});
		test('covers the full A-Z letter range with four scan-code bytes each', function () {
			for (var c = 65; c <= 90; c++) {
				var code = 'Key' + String.fromCharCode(c);
				var entry = sut.defaultCodes[code];
				assert.isArray(entry, 'defaultCodes missing ' + code);
				assert.lengthOf(entry, 4, code + ' should define 4 scan-code bytes');
			}
		});
	});

	suite('#codeKeyCodes', function () {
		test('maps letter codes to their legacy keyCode values', function () {
			assert.strictEqual(sut.codeKeyCodes['KeyA'], 65);
			assert.strictEqual(sut.codeKeyCodes['KeyZ'], 90);
		});
		test('maps modifier keys', function () {
			assert.strictEqual(sut.codeKeyCodes['ShiftLeft'], 16);
			assert.strictEqual(sut.codeKeyCodes['ControlLeft'], 17);
			assert.strictEqual(sut.codeKeyCodes['AltLeft'], 18);
		});
		test('maps function and navigation keys', function () {
			assert.strictEqual(sut.codeKeyCodes['F5'], 116);
			assert.strictEqual(sut.codeKeyCodes['Enter'], 13);
			assert.strictEqual(sut.codeKeyCodes['Escape'], 27);
			assert.strictEqual(sut.codeKeyCodes['ArrowUp'], 38);
		});
	});

	suite('#keyCodeFromCode', function () {
		test('resolves known codes through the codeKeyCodes table', function () {
			assert.strictEqual(sut.keyCodeFromCode('KeyA'), 65);
			assert.strictEqual(sut.keyCodeFromCode('ShiftLeft'), 16);
			assert.strictEqual(sut.keyCodeFromCode('F5'), 116);
			assert.strictEqual(sut.keyCodeFromCode('Enter'), 13);
			assert.strictEqual(sut.keyCodeFromCode('Digit0'), 48);
			assert.strictEqual(sut.keyCodeFromCode('ArrowUp'), 38);
		});
		test('returns undefined for unknown codes', function () {
			assert.isUndefined(sut.keyCodeFromCode('NotARealCode'));
			assert.isUndefined(sut.keyCodeFromCode('F13'));
		});
		test('returns undefined for empty or missing codes', function () {
			assert.isUndefined(sut.keyCodeFromCode(''));
			assert.isUndefined(sut.keyCodeFromCode(undefined));
			assert.isUndefined(sut.keyCodeFromCode(null));
		});
	});

	suite('#getScanCodes (KeyboardEvent.code path)', function () {
		test('returns the keydown scan code for a coded event', function () {
			var e = { originalEvent: { code: 'KeyA' } };
			assert.deepEqual(sut.getScanCodes(e, false, 'keydown'), [[0x1E, 0, 0, 0]]);
		});
		test('returns the same scan code for a keypress (no release bit)', function () {
			var e = { originalEvent: { code: 'KeyA' } };
			assert.deepEqual(sut.getScanCodes(e, false, 'keypress'), [[0x1E, 0, 0, 0]]);
		});
		test('sets the release bit for a keyup event', function () {
			var e = { originalEvent: { code: 'KeyA' } };
			assert.deepEqual(sut.getScanCodes(e, false, 'keyup'), [[0x1E | 0x80, 0, 0, 0]]);
		});
		test('does not mutate the shared defaultCodes table', function () {
			var before = JSON.stringify(sut.defaultCodes['KeyA']);
			sut.getScanCodes({ originalEvent: { code: 'KeyA' } }, false, 'keyup');
			assert.strictEqual(JSON.stringify(sut.defaultCodes['KeyA']), before);
		});
	});

	suite('#getScanCodes (keyCode fallback after loadKeyMap)', function () {
		var saved;
		setup(function () {
			saved = {
				keymap: sut.keymap,
				ctrlKeymap: sut.ctrlKeymap,
				reservedCtrlKeymap: sut.reservedCtrlKeymap,
				charmap: sut.charmap
			};
			sut.loadKeyMap('en');
		});
		teardown(function () {
			sut.keymap = saved.keymap;
			sut.ctrlKeymap = saved.ctrlKeymap;
			sut.reservedCtrlKeymap = saved.reservedCtrlKeymap;
			sut.charmap = saved.charmap;
		});
		test('resolves Enter (keyCode 13) through the loaded US keymap', function () {
			assert.deepEqual(sut.getScanCodes({ type: 'keydown', keyCode: 13 }, false, 'keydown'), [[0xE0, 0x1C, 0, 0]]);
		});
		test('resolves Shift (keyCode 16) through the loaded US keymap', function () {
			assert.deepEqual(sut.getScanCodes({ type: 'keydown', keyCode: 16 }, false, 'keydown'), [[0x2A, 0, 0]]);
		});
		test('does not resolve plain letters via the keyCode keymap', function () {
			assert.deepEqual(sut.getScanCodes({ type: 'keydown', keyCode: 65 }, false, 'keydown'), []);
		});
	});
});

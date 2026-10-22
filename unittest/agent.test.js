suite("Agent", function() {
	var sut;

	setup(function() {
		sut = new wdi.Agent({
			app: {
				sendShortcut: function() {},
				spiceConnection: { send: function() {} }
			}
		});
	});

	suite('#onAgentData clipboard (guest -> host)', function() {
		test('fires clipBoardData with the packet clipboardData', function() {
			var received = null;
			sut.addListener('clipBoardData', function (data) { received = data; });
			sut.onAgentData({
				type: wdi.AgentMessageTypes.VD_AGENT_CLIPBOARD,
				clipboardData: 'GUEST-TO-HOST-CLIP-PROOF'
			});
			assert.strictEqual(received, 'GUEST-TO-HOST-CLIP-PROOF');
		});

		test('does not fire clipBoardData for a clipboard release', function() {
			var fired = false;
			sut.addListener('clipBoardData', function () { fired = true; });
			sut.onAgentData({
				type: wdi.AgentMessageTypes.VD_AGENT_CLIPBOARD_RELEASE,
				clipboardData: 'should-not-fire'
			});
			assert.isFalse(fired);
		});
	});
});

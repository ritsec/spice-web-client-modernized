suite('SpiceConnection', function() {
	setup(function(){
		wdi.Debug.debug = false; //disable debugging, it slows tests
	});
	
	suite('#connect()', function() {
		setup(function() {
			this.mainChannel = new wdi.SpiceChannel();
			this.mock = sinon.mock(this.mainChannel);
			this.sut = this.spcConnect = new wdi.SpiceConnection({
				mainChannel:this.mainChannel,
				connectionControl: {
					connect: function() {},
					addListener: function() {}
				}
			});
			
		});

		test('Should call connect on the main channel', function() {
			this.expectation = this.mock.expects('connect').once();
			this.spcConnect.connect('localhost', 8000);
			this.mock.verify();
		});
		
		test('Should call connect on the main channel with the correct arguments', function() {
			this.expectation = this.mock.expects('connect').once().withArgs({host:'localhost', port:8000}, wdi.SpiceVars.SPICE_CHANNEL_MAIN);
			this.spcConnect.connect({host:'localhost', port:8000});
			this.mock.verify();
		});

		test('Should call connect on the connectionControl with the correct arguments', function() {
			var connectionInfo = {
				connectionControl: true
			};
			this.expectation = this.mock.expects('connect').once().withArgs(connectionInfo);
			this.spcConnect.connect(connectionInfo);
			this.mock.verify();
		});

		test.skip('When a channel fire a channelConnected message should fire channelConnected message with channel', function() {
			var channel;
			this.sut.addListener('channelConnected', function (e) {
				channel = e[1];
			}, this);

			this.mainChannel.fire('channelConnected');

			assert.equal(channel, wdi.SpiceVars.SPICE_CHANNEL_MAIN);
		});

	});
	
	suite('#connectionId()', function() {
		setup(function()  {
			this.mainChannel = new wdi.SpiceChannel();
			this.stub = sinon.stub(this.mainChannel, "connect", function() {
				this.fire("connectionId", "12345");
				this.fire("channelListAvailable", [1,2]);
			});
			
			this.displayChannel = new wdi.SpiceChannel();
			this.mock = sinon.mock(this.displayChannel);
			
			this.spcConnect = new wdi.SpiceConnection({
				mainChannel:this.mainChannel,
				displayChannel:this.displayChannel,
				connectionControl: {
					connect: function() {},
					addListener: function() {}
				}
			});
		});
		
		test('Should call connect on display channel when connectionId is available', function() {
			this.expectation = this.mock.expects('connect').once();
			this.spcConnect.connect('localhost', 8000);
			this.mock.verify();
		});
	});

	suite('#processChannelMessage()', function() {
		setup(function() {
			this.sut = new wdi.SpiceConnection({
				connectionControl: {
					connect: function() {},
					addListener: function() {}
				}
			});
			this.packet = {args: {}};
			this.extract = sinon.stub(wdi.PacketFactory, 'extract').returns(this.packet);
			this.discard = sinon.stub(wdi.GlobalPool, 'discard');
			this.record = sinon.stub(wdi.NetStats, 'recordDisplayMessage');
		});

		teardown(function() {
			this.extract.restore();
			this.discard.restore();
			this.record.restore();
		});

		test('Should pass display message type, size with header and packet to NetStats', function() {
			var type = wdi.SpiceVars.SPICE_MSG_DISPLAY_DRAW_COPY;
			this.sut.processChannelMessage({channel: wdi.SpiceVars.SPICE_CHANNEL_DISPLAY, header: {type: type, size: 100}, body: {}});
			assert.isTrue(this.record.calledWithExactly(type, 106, this.packet));
		});

		test('Should move the ACK token to the decoded packet', function() {
			var token = {send: sinon.spy()};
			this.sut.processChannelMessage({channel: wdi.SpiceVars.SPICE_CHANNEL_DISPLAY, header: {type: 102, size: 0}, body: {}, ackToken: token});
			assert.equal(this.packet.ackToken, token);
			assert.isFalse(token.send.called);
		});

		test('Should send the ACK right away when the message cannot be decoded', function() {
			this.extract.returns(false);
			var token = {send: sinon.spy()};
			this.sut.processChannelMessage({channel: wdi.SpiceVars.SPICE_CHANNEL_DISPLAY, header: {type: 999, size: 0}, body: {}, ackToken: token});
			assert.isTrue(token.send.calledOnce);
		});

		test('Should not pass other channels to NetStats', function() {
			this.sut.processChannelMessage({channel: wdi.SpiceVars.SPICE_CHANNEL_CURSOR, header: {type: 101, size: 100}, body: {}});
			assert.isFalse(this.record.called);
		});
	});

});
	

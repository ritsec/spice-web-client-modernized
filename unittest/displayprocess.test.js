suite('DisplayProcess', function() {
	var sut;
	var runQ;
	var fakePacketFilter;
	var fakeClientGui;
	var displayRouter;
	var packetWorkerIdentifier;

	setup(function(){
		wdi.Debug.debug = false; //disable debugging, it slows tests
	});

	suite('#process()', function() {
		setup(function() {
			runQ = new wdi.RunQueue();

			fakePacketFilter = {
				notifyEnd: function() {

				},

				filter: function(o, fn, scope) {
					fn.call(scope, o);
				}
			};

			fakeClientGui =  {};

			displayRouter = new wdi.DisplayRouter();

			packetWorkerIdentifier = {
				getImageProperties: function() {
					return false;
				}
			};

			displayRouter.packetProcess = function(spiceMessage) {}; //replace packetProcess, because of partial mocking
			sut = new wdi.DisplayProcess({
				runQ: runQ,
				packetFilter: fakePacketFilter,
				clientGui: fakeClientGui,
				displayRouter: displayRouter,
				packetWorkerIdentifier: packetWorkerIdentifier
			});


			wdi.ExecutionControl.sync = true;
		});

		test('displayProcess process should call packetFilfer process', sinon.test(function() {
			var fakeProxy = {
				end:function() {

				}
			};
			runQ.add = function(fnStart, scope, fnEnd) {
				fnStart.call(scope, fakeProxy);
			}
			this.mock(fakePacketFilter)
				.expects('filter')
				.once();
			sut._process(false);
		}));

		test('displayProcess process should call packetFilfer notifyEnd', sinon.test(function() {
			runQ.add = function(fn, scope, endFn) {
				fn.call(scope,{end:function(){}});
				endFn.call(scope);
			};

			this.mock(fakePacketFilter)
				.expects('notifyEnd')
				.once();
			sut._process(false);
		}));

		test('displayProcess process should call runq add', sinon.test(function() {
			this.mock(runQ)
				.expects('add')
				.once();
			sut._process(false);
		}));


		test('displayProcess process should call runq process', sinon.test(function() {
			this.mock(runQ)
				.expects('process')
				.once();
			sut._process(false);
		}));

		test('displayProcess process should call runq process', sinon.test(function() {
			this.mock(runQ)
				.expects('process')
				.once();
			sut._process(false);
		}));

		test('processEnd sends the ACK carried by the message', function() {
			var message = {ackToken: {send: sinon.spy()}};
			sut.processEnd(message, fakeClientGui);
			assert.isTrue(message.ackToken.send.calledOnce);
		});

		test('removeRedundantDraws sends the ACK of a draw it drops', function() {
			var fakeDraw = function(box, ackToken) {
				return {
					messageType: wdi.SpiceVars.SPICE_MSG_DISPLAY_DRAW_COPY,
					ackToken: ackToken,
					args: {
						base: {surface_id: 0, box: box, clip: {type: 0}},
						rop_descriptor: wdi.SpiceRopd.SPICE_ROPD_OP_PUT,
						getMessageProperty: function(name, defaultValue) {
							return name === 'overWriteScreenArea' ? true : defaultValue;
						}
					}
				};
			};
			var covered = fakeDraw({top: 10, left: 10, bottom: 20, right: 20}, {send: sinon.spy()});
			var cover = fakeDraw({top: 0, left: 0, bottom: 100, right: 100}, null);
			sut.waitingMessages = [covered, cover];
			sut.removeRedundantDraws();
			assert.deepEqual(sut.waitingMessages, [cover]);
			assert.isTrue(covered.ackToken.send.calledOnce);
		});

		test('processEnd tells NetStats the message was drawn', function() {
			var message = {};
			var record = sinon.stub(wdi.NetStats, 'recordDrawDone');
			wdi.NetStats.enabled = true;
			try {
				sut.processEnd(message, fakeClientGui);
			} finally {
				wdi.NetStats.enabled = false;
				record.restore();
			}
			assert.isTrue(record.calledWithExactly(message));
		});
	});
});

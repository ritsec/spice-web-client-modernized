// Bandwidth and draw-latency counters for the SPICE channels.
// Off by default. Open index.html?netstats=1 to print a report to the console
// every 5 seconds, or call wdi.NetStats.start() and wdi.NetStats.report() by hand.
wdi.NetStats = {
	enabled: false,
	intervalMs: 5000,
	timer: null,
	topRectCount: 5,
	channelNames: {1: 'main', 2: 'display', 3: 'inputs', 4: 'cursor', 5: 'playback', 6: 'record'},

	windowStart: 0,
	channels: {},
	display: {},
	displayBytes: 0,
	fullSurface: {count: 0, bytes: 0},
	dropped: {count: 0, bytes: 0},
	rects: {},
	latencies: [],
	acks: 0,
	fallbackAcks: 0,

	// Survive resets: surface sizes come from SURFACE_CREATE, which only arrives
	// at connect or on a mode change, and messages can straddle two windows.
	surfaces: {},
	arrivals: new WeakMap(),

	messageNames: null,
	imageNames: null,

	start: function(intervalMs) {
		this.stop();
		if (intervalMs) {
			this.intervalMs = intervalMs;
		}
		this.enabled = true;
		this.reset();
		var self = this;
		this.timer = setInterval(function() {
			self.report();
			self.reset();
		}, this.intervalMs);
	},

	stop: function() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.enabled = false;
	},

	reset: function() {
		this.windowStart = this.now();
		this.channels = {};
		this.display = {};
		this.displayBytes = 0;
		this.fullSurface = {count: 0, bytes: 0};
		this.dropped = {count: 0, bytes: 0};
		this.rects = {};
		this.latencies = [];
		this.acks = 0;
		this.fallbackAcks = 0;
	},

	now: function() {
		return performance.now();
	},

	getChannel: function(channel) {
		if (!this.channels[channel]) {
			this.channels[channel] = {recvBytes: 0, recvMsgs: 0, sentBytes: 0, sentMsgs: 0};
		}
		return this.channels[channel];
	},

	recordReceived: function(channel, bytes) {
		var stats = this.getChannel(channel);
		stats.recvBytes += bytes;
		stats.recvMsgs++;
	},

	recordSent: function(channel, bytes) {
		var stats = this.getChannel(channel);
		stats.sentBytes += bytes;
		stats.sentMsgs++;
	},

	// Called for every display message, enabled or not, so surface sizes are
	// known when stats get turned on mid-session.
	recordDisplayMessage: function(type, bytes, packet) {
		var args = packet ? packet.args : null;
		if (args && type === wdi.SpiceVars.SPICE_MSG_DISPLAY_SURFACE_CREATE) {
			this.surfaces[args.surface_id] = {width: args.width, height: args.height};
		} else if (args && type === wdi.SpiceVars.SPICE_MSG_DISPLAY_SURFACE_DESTROY) {
			delete this.surfaces[args.surface_id];
		}

		if (!this.enabled) {
			return;
		}

		var label = this.getMessageLabel(type, args);
		if (!packet) {
			label += ' (not decoded)';
		}
		if (!this.display[label]) {
			this.display[label] = {count: 0, bytes: 0};
		}
		this.display[label].count++;
		this.display[label].bytes += bytes;
		this.displayBytes += bytes;

		if (!packet) {
			return;
		}
		this.arrivals.set(packet, {time: this.now(), bytes: bytes});

		var base = args ? args.base : null;
		if (!base || !base.box) {
			return;
		}
		var box = base.box;
		var width = box.right - box.left;
		var height = box.bottom - box.top;
		var key = 's' + base.surface_id + ' ' + width + 'x' + height + ' @' + box.left + ',' + box.top;
		if (!this.rects[key]) {
			this.rects[key] = {count: 0, bytes: 0};
		}
		this.rects[key].count++;
		this.rects[key].bytes += bytes;

		var surface = this.surfaces[base.surface_id];
		if (surface && box.left <= 0 && box.top <= 0 && box.right >= surface.width && box.bottom >= surface.height) {
			this.fullSurface.count++;
			this.fullSurface.bytes += bytes;
		}
	},

	// The display process calls these once a message is drawn, or once it is
	// thrown away because a later draw covers it.
	recordDrawDone: function(message) {
		var arrival = message ? this.arrivals.get(message) : null;
		if (!arrival) {
			return;
		}
		this.arrivals.delete(message);
		this.latencies.push(this.now() - arrival.time);
	},

	recordDropped: function(message) {
		var arrival = message ? this.arrivals.get(message) : null;
		if (!arrival) {
			return;
		}
		this.arrivals.delete(message);
		this.dropped.count++;
		this.dropped.bytes += arrival.bytes;
	},

	recordAck: function(isFallback) {
		this.acks++;
		if (isFallback) {
			this.fallbackAcks++;
		}
	},

	getMessageLabel: function(type, args) {
		if (!this.messageNames) {
			this.messageNames = this.buildNames(wdi.SpiceVars, 'SPICE_MSG_DISPLAY_', false);
			this.imageNames = this.buildNames(wdi.SpiceImageType, 'SPICE_IMAGE_TYPE_', true);
		}
		var label = this.messageNames[type] || ('type ' + type);
		var descriptor = args ? this.getImageDescriptor(args) : null;
		if (descriptor) {
			label += ' ' + (this.imageNames[descriptor.type] || ('image ' + descriptor.type));
		}
		return label;
	},

	getImageDescriptor: function(args) {
		if (args.image && args.image.imageDescriptor) {
			return args.image.imageDescriptor;
		}
		if (args.src_image && args.src_image.imageDescriptor) {
			return args.src_image.imageDescriptor;
		}
		if (args.brush && args.brush.pattern && args.brush.pattern.image) {
			return args.brush.pattern.image;
		}
		return null;
	},

	buildNames: function(constants, prefix, lowercase) {
		var names = {};
		for (var key in constants) {
			if (constants.hasOwnProperty(key) && key.indexOf(prefix) === 0) {
				var name = key.substring(prefix.length);
				names[constants[key]] = lowercase ? name.toLowerCase() : name;
			}
		}
		return names;
	},

	getSnapshot: function() {
		var seconds = Math.max((this.now() - this.windowStart) / 1000, 0.001);
		var self = this;

		var channels = Object.keys(this.channels).map(function(channel) {
			var stats = self.channels[channel];
			return {
				channel: self.channelNames[channel] || channel,
				'recv kB/s': self.round(stats.recvBytes / 1000 / seconds),
				'recv msg/s': self.round(stats.recvMsgs / seconds),
				'sent kB/s': self.round(stats.sentBytes / 1000 / seconds),
				'sent msg/s': self.round(stats.sentMsgs / seconds)
			};
		});

		var display = this.sortByBytes(this.display).map(function(entry) {
			return {
				message: entry.key,
				count: entry.count,
				kB: self.round(entry.bytes / 1000),
				'avg kB': self.round(entry.bytes / entry.count / 1000),
				'% of bytes': self.percent(entry.bytes, self.displayBytes)
			};
		});

		var rects = this.sortByBytes(this.rects).slice(0, this.topRectCount).map(function(entry) {
			return {
				rect: entry.key,
				count: entry.count,
				kB: self.round(entry.bytes / 1000)
			};
		});

		return {
			seconds: this.round(seconds),
			channels: channels,
			display: display,
			displayBytes: this.displayBytes,
			fullSurface: {
				count: this.fullSurface.count,
				kB: this.round(this.fullSurface.bytes / 1000),
				'% of bytes': this.percent(this.fullSurface.bytes, this.displayBytes)
			},
			dropped: {
				count: this.dropped.count,
				kB: this.round(this.dropped.bytes / 1000),
				'% of bytes': this.percent(this.dropped.bytes, this.displayBytes)
			},
			latency: this.getLatency(),
			acks: {count: this.acks, fallback: this.fallbackAcks},
			rects: rects
		};
	},

	getLatency: function() {
		var sorted = this.latencies.slice().sort(function(a, b) {
			return a - b;
		});
		var count = sorted.length;
		var pick = function(fraction) {
			return count ? sorted[Math.min(count - 1, Math.floor(fraction * count))] : 0;
		};
		return {
			count: count,
			'p50 ms': this.round(pick(0.5)),
			'p95 ms': this.round(pick(0.95)),
			'max ms': this.round(count ? sorted[count - 1] : 0)
		};
	},

	sortByBytes: function(map) {
		return Object.keys(map).map(function(key) {
			return {key: key, count: map[key].count, bytes: map[key].bytes};
		}).sort(function(a, b) {
			return b.bytes - a.bytes;
		});
	},

	round: function(value) {
		return Math.round(value * 10) / 10;
	},

	percent: function(part, total) {
		return total ? this.round(part / total * 100) : 0;
	},

	report: function() {
		var snapshot = this.getSnapshot();
		if (!snapshot.channels.length) {
			console.log('[netstats] no traffic in the last ' + snapshot.seconds + ' s');
			return snapshot;
		}
		console.log('[netstats] last ' + snapshot.seconds + ' s');
		console.table(snapshot.channels);
		if (snapshot.display.length) {
			console.table(snapshot.display);
			console.log('[netstats] full-surface draws: ' + snapshot.fullSurface.count +
				' (' + snapshot.fullSurface.kB + ' kB, ' + snapshot.fullSurface['% of bytes'] + '% of display bytes)');
			console.log('[netstats] dropped before drawing: ' + snapshot.dropped.count +
				' (' + snapshot.dropped.kB + ' kB, ' + snapshot.dropped['% of bytes'] + '% of display bytes)');
			console.log('[netstats] arrival to drawn: p50 ' + snapshot.latency['p50 ms'] + ' ms, p95 ' +
				snapshot.latency['p95 ms'] + ' ms, max ' + snapshot.latency['max ms'] + ' ms over ' +
				snapshot.latency.count + ' messages');
			console.log('[netstats] display ACKs sent after drawing: ' + snapshot.acks.count +
				', by fallback timer: ' + snapshot.acks.fallback);
			console.table(snapshot.rects);
		}
		return snapshot;
	}
};

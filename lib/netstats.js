// Bandwidth, decode and draw counters for the SPICE channels.
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
	longTasks: 0,
	longTaskMs: 0,
	longTaskObserver: null,

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
		this.startLongTaskObserver();
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
		if (this.longTaskObserver) {
			this.longTaskObserver.disconnect();
			this.longTaskObserver = null;
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
		this.longTasks = 0;
		this.longTaskMs = 0;
	},

	now: function() {
		return performance.now();
	},

	// Long tasks block input handling. Only Chromium reports them.
	startLongTaskObserver: function() {
		if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes ||
			PerformanceObserver.supportedEntryTypes.indexOf('longtask') === -1) {
			return;
		}
		var self = this;
		this.longTaskObserver = new PerformanceObserver(function(list) {
			list.getEntries().forEach(function(entry) {
				self.longTasks++;
				self.longTaskMs += entry.duration;
			});
		});
		this.longTaskObserver.observe({type: 'longtask'});
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

	// Rows are created on first use, so decode and draw times for a message that
	// arrived in the previous window still land on its row.
	getRow: function(label) {
		if (!this.display[label]) {
			this.display[label] = {count: 0, bytes: 0, decodeMs: 0, decodeCount: 0, decodePixels: 0, drawMs: 0, drawCount: 0};
		}
		return this.display[label];
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
		var row = this.getRow(label);
		row.count++;
		row.bytes += bytes;
		this.displayBytes += bytes;

		if (!packet) {
			return;
		}
		this.arrivals.set(packet, {time: this.now(), bytes: bytes, label: label, drawStart: null});

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

	// Time from handing an image to a worker until its pixels come back.
	recordDecode: function(message, ms, pixels) {
		var arrival = message ? this.arrivals.get(message) : null;
		if (!arrival) {
			return;
		}
		var row = this.getRow(arrival.label);
		row.decodeMs += ms;
		row.decodeCount++;
		row.decodePixels += pixels;
	},

	recordDrawStart: function(message) {
		var arrival = message ? this.arrivals.get(message) : null;
		if (arrival) {
			arrival.drawStart = this.now();
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
		var now = this.now();
		this.latencies.push(now - arrival.time);
		if (arrival.drawStart !== null) {
			var row = this.getRow(arrival.label);
			row.drawMs += now - arrival.drawStart;
			row.drawCount++;
		}
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
			var row = entry.row;
			return {
				message: entry.key,
				count: row.count,
				kB: self.round(row.bytes / 1000),
				'avg kB': row.count ? self.round(row.bytes / row.count / 1000) : null,
				'% of bytes': self.percent(row.bytes, self.displayBytes),
				'decode ms': row.decodeCount ? self.round(row.decodeMs / row.decodeCount) : null,
				'decode ms/MP': row.decodePixels ? self.round(row.decodeMs / (row.decodePixels / 1000000)) : null,
				'draw ms': row.drawCount ? self.round(row.drawMs / row.drawCount) : null
			};
		});

		var rects = this.sortByBytes(this.rects).slice(0, this.topRectCount).map(function(entry) {
			return {
				rect: entry.key,
				count: entry.row.count,
				kB: self.round(entry.row.bytes / 1000)
			};
		});

		return {
			seconds: this.round(seconds),
			cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || null,
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
			longTasks: this.longTaskObserver ? {count: this.longTasks, ms: this.round(this.longTaskMs)} : null,
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
			return {key: key, row: map[key]};
		}).sort(function(a, b) {
			return b.row.bytes - a.row.bytes;
		});
	},

	round: function(value) {
		return Math.round(value * 10) / 10;
	},

	percent: function(part, total) {
		return total ? this.round(part / total * 100) : 0;
	},

	// The whole report as one text block, so it reads in one place and copies cleanly.
	format: function(snapshot) {
		var lines = [
			'[netstats] last ' + snapshot.seconds + ' s' + (snapshot.cores ? ' | cores ' + snapshot.cores : ''),
			this.formatColumns(['channel', 'recv kB/s', 'recv msg/s', 'sent kB/s', 'sent msg/s'], snapshot.channels)
		];

		if (snapshot.display.length) {
			lines.push('', this.formatColumns(
				['message', 'count', 'kB', 'avg kB', '% of bytes', 'decode ms', 'decode ms/MP', 'draw ms'],
				snapshot.display
			));

			var latency = snapshot.latency;
			var longTasks = snapshot.longTasks;
			lines.push('', [
				'arrival->drawn p50 ' + latency['p50 ms'] + ' ms, p95 ' + latency['p95 ms'] + ' ms, max ' +
					latency['max ms'] + ' ms (' + latency.count + ' drawn)',
				'full-surface ' + snapshot.fullSurface.count + ' (' + snapshot.fullSurface['% of bytes'] + '% of bytes)',
				'dropped ' + snapshot.dropped.count + ' (' + snapshot.dropped.kB + ' kB, ' + snapshot.dropped['% of bytes'] + '%)',
				'long tasks ' + (longTasks ? longTasks.count + ' (' + longTasks.ms + ' ms)' : 'n/a'),
				'display ACKs ' + snapshot.acks.count + ', fallback ' + snapshot.acks.fallback
			].join(' | '));

			if (snapshot.rects.length) {
				lines.push('top rects: ' + snapshot.rects.map(function(rect) {
					return rect.rect + ' x' + rect.count + ' ' + rect.kB + ' kB';
				}).join('; '));
			}
		}

		return lines.join('\n');
	},

	// Pads each column to its widest cell: first column left-aligned, the rest right-aligned.
	formatColumns: function(columns, rows) {
		var cells = [columns].concat(rows.map(function(row) {
			return columns.map(function(column) {
				var value = row[column];
				return value === null || value === undefined ? '-' : String(value);
			});
		}));
		var widths = [];
		for (var i = 0; i < columns.length; i++) {
			widths.push(Math.max.apply(null, cells.map(function(cell) {
				return cell[i].length;
			})));
		}
		return cells.map(function(cell) {
			return cell.map(function(text, i) {
				var padding = new Array(widths[i] - text.length + 1).join(' ');
				return i === 0 ? text + padding : padding + text;
			}).join('  ');
		}).join('\n');
	},

	report: function() {
		var snapshot = this.getSnapshot();
		if (!snapshot.channels.length) {
			console.log('[netstats] no traffic in the last ' + snapshot.seconds + ' s');
		} else {
			console.log(this.format(snapshot));
		}
		return snapshot;
	}
};

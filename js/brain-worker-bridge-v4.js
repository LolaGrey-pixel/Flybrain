/* brain-worker-bridge-v4.js — T7.4 + FisHKA (v4)
 *
 * Единственное отличие от прежней версии — три места:
 * 1. В шапке имя файла (для ясности).
 * 2. В case 'tick' → updateHologram принимает третий аргумент e.data.fishkaFeatures.
 * 3. В строке new Worker — путь остаётся 'js/sim-worker.js' (не меняется,
 *    так как sim-worker.js вы не переименовывали).
 */

(function () {
	'use strict';

	var STIM_INTENSITY = 0.15;
	var FIRE_STATE_SCALE = 100;

	function fetchBinaryWithProgress(url, onProgress) {
		return new Promise(function (resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open('GET', url, true);
			xhr.responseType = 'arraybuffer';
			xhr.onprogress = function (e) {
				if (e.lengthComputable) {
					onProgress(e.loaded, e.total);
				} else {
					onProgress(e.loaded, 0);
				}
			};
			xhr.onload = function () {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve(xhr.response);
				} else {
					reject(new Error('HTTP ' + xhr.status + ' fetching ' + url));
				}
			};
			xhr.onerror = function () {
				reject(new Error('Network error fetching ' + url));
			};
			xhr.send();
		});
	}

	function updateLoadingProgress(loaded, total) {
		var subtitle = document.getElementById('connectomeSubtitle');
		if (!subtitle) return;
		var loadedMB = (loaded / (1024 * 1024)).toFixed(1);
		if (total > 0) {
			var totalMB = (total / (1024 * 1024)).toFixed(1);
			subtitle.textContent = 'Loading connectome... ' + loadedMB + ' / ' + totalMB + ' MB';
		} else {
			subtitle.textContent = 'Loading connectome... ' + loadedMB + ' MB';
		}
		subtitle.classList.add('loading');
	}

	var legacyUpdate = BRAIN.update;

	var worker = null;
	var workerReady = false;
	var latestFireState = null;
	var neuronCount = 0;
	var groupCount = 0;
	var groupIdArr = null;
	var regionTypeArr = null;
	var groupIndices = null;
	var groupSizes = null;
	var groupNameToId = {};
	var groupIdToName = [];
	var pendingGroupSpikes = null;
	var pendingWorkerTicks = 0;
	var pendingDriveFrames = 0;

	function initBridge() {
		var metaUrl = 'data/neuron_meta.json';
		var binUrl = 'data/connectome.bin.gz';
		var subtitle = document.getElementById('connectomeSubtitle');
		if (subtitle) {
			subtitle.textContent = 'Loading connectome...';
			subtitle.classList.add('loading');
		}

		fetch(metaUrl)
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + metaUrl);
				return res.json();
			})
			.then(function (meta) {
				groupCount = meta.group_count;
				groupSizes = meta.group_sizes;
				for (var i = 0; i < meta.groups.length; i++) {
					var g = meta.groups[i];
					groupNameToId[g.name] = g.id;
					groupIdToName[g.id] = g.name;
				}
				return fetchBinaryWithProgress(binUrl, updateLoadingProgress);
			})
			.then(function (buffer) {
				if (subtitle) {
					subtitle.textContent = 'Parsing connectome...';
				}
				worker = new Worker('js/sim-worker.js');
				worker.onmessage = handleWorkerMessage;
				worker.onerror = handleWorkerError;
				worker.postMessage({type: 'init', buffer: buffer}, [buffer]);
			})
			.catch(function (err) {
				console.warn('connectome.bin.gz load failed, using 59-group BRAIN.update():', err);
				BRAIN.update = legacyUpdate;
				if (subtitle) {
					subtitle.textContent = '59 neuron groups \u2014 FlyWire approximation (fallback)';
					subtitle.classList.remove('loading');
				}
			});
	}

	function handleWorkerMessage(e) {
		switch (e.data.type) {
		case 'ready':
			neuronCount = e.data.neuronCount;
			groupIdArr = new Uint16Array(e.data.groupId.buffer
				? e.data.groupId.buffer : e.data.groupId);
			regionTypeArr = new Uint8Array(e.data.regionType.buffer
				? e.data.regionType.buffer : e.data.regionType);
			pendingGroupSpikes = new Float32Array(groupCount);
			pendingWorkerTicks = 0;
			buildGroupIndices();
			workerReady = true;
			BRAIN.workerReady = true;
			BRAIN.workerNeuronCount = neuronCount;
			BRAIN.workerRegionType = regionTypeArr;
			BRAIN.workerGroupIdArr = groupIdArr;
			BRAIN.workerGroupIdToName = groupIdToName;
			BRAIN.workerGroupSizes = groupSizes;
			BRAIN.workerEdgeCount = e.data.edgeCount;

			for (var ps in BRAIN.postSynaptic) {
				BRAIN.postSynaptic[ps][0] = 0;
				BRAIN.postSynaptic[ps][1] = 0;
			}

			BRAIN.update = workerUpdate;
			worker.postMessage({type: 'start'});
			console.log('Connectome worker ready: ' + neuronCount + ' neurons, ' +
				e.data.edgeCount + ' edges');
			var subtitle = document.getElementById('connectomeSubtitle');
			if (subtitle) {
				subtitle.textContent = neuronCount.toLocaleString() + ' neurons / ' +
					e.data.edgeCount.toLocaleString() + ' connections \u2014 FlyWire FAFB v783';
				subtitle.classList.remove('loading');
			}
			var scaleEl = document.getElementById('scaleIndicator');
			if (scaleEl) {
				scaleEl.textContent = neuronCount.toLocaleString() + ' neurons / ' +
					e.data.edgeCount.toLocaleString() + ' connections \u2014 FlyWire FAFB v783';
				scaleEl.style.display = '';
			}
			break;

		case 'tick':
			latestFireState = e.data.fireState;
			BRAIN.latestFireState = e.data.fireState;
			BRAIN.workerFiredNeurons = e.data.firedNeurons || 0;
			if (pendingGroupSpikes && e.data.groupSpikeCounts) {
				for (var g = 0; g < groupCount; g++) {
					pendingGroupSpikes[g] += e.data.groupSpikeCounts[g] || 0;
				}
				pendingWorkerTicks++;
			}
			// ИСПРАВЛЕНО v4: третий аргумент e.data.fishkaFeatures
			if (e.data.fishkaPCM && typeof FisHKA_Main !== 'undefined') {
				FisHKA_Main.updateHologram(
					e.data.fishkaPCM.mag,
					e.data.fishkaPCM.phase,
					e.data.fishkaFeatures || null
				);
			}
			break;

		case 'stats':
			var statsSubtitle = document.getElementById('connectomeSubtitle');
			if (statsSubtitle && !statsSubtitle.classList.contains('loading')) {
				var firedPct = Math.round((e.data.firedNeurons || 0) / e.data.totalNeurons * 100);
				var activePct = Math.round(e.data.activeNeurons / e.data.totalNeurons * 100);
				statsSubtitle.textContent = neuronCount.toLocaleString() + ' neurons (' +
					firedPct + '% firing, ' + activePct + '% active groups, ' +
					e.data.avgTickMs.toFixed(1) + 'ms/tick) \u2014 FlyWire FAFB v783';
			}
			break;

		case 'error':
			console.warn('Worker error: ' + e.data.message);
			if (workerReady) {
				console.warn('Falling back to 59-group BRAIN.update()');
				workerReady = false;
				BRAIN.workerReady = false;
				BRAIN.update = legacyUpdate;
			}
			break;
		}
	}

	function handleWorkerError(err) {
		console.warn('Worker crashed, falling back to 59-group BRAIN.update():', err.message || err);
		workerReady = false;
		BRAIN.workerReady = false;
		BRAIN.update = legacyUpdate;
		var subtitle = document.getElementById('connectomeSubtitle');
		if (subtitle) {
			subtitle.textContent = '59 neuron groups \u2014 FlyWire approximation (fallback)';
			subtitle.classList.remove('loading');
		}
	}

	function buildGroupIndices() {
		var counts = new Uint32Array(groupCount);
		for (var i = 0; i < neuronCount; i++) {
			counts[groupIdArr[i]]++;
		}
		groupIndices = new Array(groupCount);
		for (var g = 0; g < groupCount; g++) {
			groupIndices[g] = new Uint32Array(counts[g]);
			counts[g] = 0;
		}
		for (var i = 0; i < neuronCount; i++) {
			var gid = groupIdArr[i];
			groupIndices[gid][counts[gid]++] = i;
		}
	}

	var MOTOR_SCALE = 0.6;

	function readPS(name) {
		if (!BRAIN.postSynaptic[name]) return 0;
		return BRAIN.postSynaptic[name][BRAIN.nextState] || 0;
	}

	function addPS(name, val) {
		if (!BRAIN.postSynaptic[name]) return;
		BRAIN.postSynaptic[name][BRAIN.nextState] += val;
	}

	function synthesizeMotorOutputs() {
		var desc = readPS('GNG_DESC');
		var vcpg = readPS('VNC_CPG');

		var cxPfn = readPS('CX_PFN');
		var cxFc = readPS('CX_FC');
		var cxEpg = readPS('CX_EPG');
		var cxHd = readPS('CX_HDELTA');
		var sezFeed = readPS('SEZ_FEED');
		var sezGroom = readPS('SEZ_GROOM');
		var mbApp = readPS('MB_MBON_APP');
		var mbAv = readPS('MB_MBON_AV');
		var lhApp = readPS('LH_APP');
		var lhAv = readPS('LH_AV');
		var dFear = readPS('DRIVE_FEAR');
		var dGroom = readPS('DRIVE_GROOM');
		var prob = readPS('MN_PROBOSCIS');
		var head = readPS('MN_HEAD');
		var dnStartle = readPS('DN_STARTLE');
		var noci = readPS('NOCI');

		var walkIntent = (cxPfn + cxFc + cxEpg) * 0.3 + (mbApp + lhApp) * 0.5 + (desc + vcpg) * 0.2;
		var flightIntent = dFear * 2.0 + (mbAv + lhAv) * 0.8 + dnStartle * 1.5 + noci * 1.0;
		var groomIntent = dGroom * 1.5 + sezGroom * 1.0;
		var feedIntent = sezFeed * 1.0 + prob * 0.5;
		var descProxy = Math.max(
			walkIntent * 0.45,
			flightIntent * 0.35,
			groomIntent * 0.3,
			feedIntent * 0.25
		);
		if (descProxy > desc) {
			desc = descProxy;
			if (BRAIN.postSynaptic.GNG_DESC) {
				BRAIN.postSynaptic.GNG_DESC[BRAIN.nextState] = desc;
			}
		}
		var total = desc + vcpg;
		if (total < 0.5) return;

		var baseWalk = total * MOTOR_SCALE;
		var walkDrive = baseWalk * (1.0 + walkIntent * 0.1);

		var jitter = (Math.random() - 0.5) * 0.04;
		var walkL = walkDrive * (1.0 + jitter) / 3.0;
		var walkR = walkDrive * (1.0 - jitter) / 3.0;

		addPS('MN_LEG_L1', walkL);
		addPS('MN_LEG_L2', walkL);
		addPS('MN_LEG_L3', walkL);
		addPS('MN_LEG_R1', walkR);
		addPS('MN_LEG_R2', walkR);
		addPS('MN_LEG_R3', walkR);

		if (flightIntent > 1.0) {
			var flightDrive = flightIntent * MOTOR_SCALE * 0.7;
			addPS('MN_WING_L', flightDrive);
			addPS('MN_WING_R', flightDrive);
		}

		if (dFear > 3.0) {
			addPS('DN_STARTLE', dFear * MOTOR_SCALE);
		}

		if (groomIntent > 1.0) {
			addPS('MN_ABDOMEN', groomIntent * MOTOR_SCALE * 0.3);
		}

		if (feedIntent > 0.5) {
			addPS('MN_PROBOSCIS', feedIntent * MOTOR_SCALE * 0.3);
		}
	}

	function workerUpdate() {
		pendingDriveFrames = Math.min(pendingDriveFrames + 1, 20);

		sendOneShotStimuli();

		if (latestFireState || pendingWorkerTicks > 0) {
			for (var i = 0; i < pendingDriveFrames; i++) {
				BRAIN.updateDrives();
			}
			pendingDriveFrames = 0;

			sendStimulation();
			aggregateFireState();

			var vd = BRAIN.drives;
			if (BRAIN.postSynaptic['DRIVE_FEAR'])
				BRAIN.postSynaptic['DRIVE_FEAR'][BRAIN.nextState] = vd.fear * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_CURIOSITY'])
				BRAIN.postSynaptic['DRIVE_CURIOSITY'][BRAIN.nextState] = vd.curiosity * FIRE_STATE_SCALE;
			if (BRAIN.postSynaptic['DRIVE_GROOM'])
				BRAIN.postSynaptic['DRIVE_GROOM'][BRAIN.nextState] = vd.groom * FIRE_STATE_SCALE;

			synthesizeMotorOutputs();
			BRAIN.motorcontrol();

			if (typeof FisHKA_Main !== 'undefined' && BRAIN && BRAIN.drives) {
				var fhkBehavior = (typeof behavior !== 'undefined' && behavior.current)
					? behavior.current : 'idle';
				FisHKA_Main.update(BRAIN, fhkBehavior);
			}

			for (var ps in BRAIN.postSynaptic) {
				BRAIN.postSynaptic[ps][BRAIN.thisState] =
					BRAIN.postSynaptic[ps][BRAIN.nextState];
			}
			var temp = BRAIN.thisState;
			BRAIN.thisState = BRAIN.nextState;
			BRAIN.nextState = temp;
		}
	}

	function collectOneShotSegments() {
		var segs = [];
		if (BRAIN.stimulate.nociception) {
			segs.push({name: 'NOCI', intensity: STIM_INTENSITY * 5});
			BRAIN.stimulate.nociception = false;
		}
		return segs;
	}

	function collectStimulationSegments() {
		var segs = [];
		var d = BRAIN.drives;

		if (d.hunger > 0.2) {
			var pulses = d.hunger > 0.6 ? 3 : (d.hunger > 0.4 ? 2 : 1);
			segs.push({name: 'DRIVE_HUNGER', intensity: STIM_INTENSITY * d.hunger * pulses});
		}
		if (d.fear > 0.05) {
			var pulses = d.fear > 0.5 ? 3 : (d.fear > 0.2 ? 2 : 1);
			segs.push({name: 'DRIVE_FEAR', intensity: STIM_INTENSITY * d.fear * pulses});
		}
		if (d.fatigue > 0.3) {
			segs.push({name: 'DRIVE_FATIGUE', intensity: STIM_INTENSITY * d.fatigue});
		}
		if (d.curiosity > 0.2) {
			var pulses = d.curiosity > 0.5 ? 2 : 1;
			segs.push({name: 'DRIVE_CURIOSITY', intensity: STIM_INTENSITY * d.curiosity * pulses});
		}
		if (d.groom > 0.3) {
			segs.push({name: 'DRIVE_GROOM', intensity: STIM_INTENSITY * d.groom});
		}

		if (BRAIN.stimulate.touch) {
			segs.push({name: 'MECH_BRISTLE', intensity: STIM_INTENSITY});
			if (BRAIN.stimulate.touchLocation === 'head' ||
				BRAIN.stimulate.touchLocation === 'thorax') {
				segs.push({name: 'MECH_BRISTLE', intensity: STIM_INTENSITY});
			}
		}
		if (BRAIN.stimulate.foodNearby) {
			segs.push({name: 'OLF_ORN_FOOD', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.foodContact) {
			segs.push({name: 'GUS_GRN_SWEET', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.dangerOdor) {
			segs.push({name: 'OLF_ORN_DANGER', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.wind) {
			segs.push({name: 'MECH_JO', intensity: STIM_INTENSITY * BRAIN.stimulate.windStrength});
		}
		if (BRAIN.stimulate.lightLevel > 0.2) {
			segs.push({name: 'VIS_R1R6', intensity: STIM_INTENSITY * BRAIN.stimulate.lightLevel});
			segs.push({name: 'VIS_R7R8', intensity: STIM_INTENSITY * BRAIN.stimulate.lightLevel * 0.7});
		}
		if (BRAIN.stimulate.temperature > 0.65) {
			var warmIntensity = (BRAIN.stimulate.temperature - 0.5) * 2;
			segs.push({name: 'THERMO_WARM', intensity: STIM_INTENSITY * warmIntensity});
		} else if (BRAIN.stimulate.temperature < 0.35) {
			var coolIntensity = (0.5 - BRAIN.stimulate.temperature) * 2;
			segs.push({name: 'THERMO_COOL', intensity: STIM_INTENSITY * coolIntensity});
		}
		if (BRAIN._isMoving) {
			segs.push({name: 'MECH_CHORD', intensity: STIM_INTENSITY});
		}
		if (BRAIN.stimulate.lightLevel > 0.1 && BRAIN._isMoving) {
			segs.push({name: 'VIS_LPTC', intensity: STIM_INTENSITY * 0.3});
		}

		var tonicIntensity = BRAIN.stimulate.lightLevel === 0 ? 0.03 : 0.08;
		segs.push({name: 'CX_FC', intensity: tonicIntensity});
		segs.push({name: 'CX_EPG', intensity: tonicIntensity});
		segs.push({name: 'CX_PFN', intensity: tonicIntensity});

		return segs;
	}

	function sendOneShotStimuli() {
		var segs = collectOneShotSegments();
		if (!worker || segs.length === 0) return;
		for (var s = 0; s < segs.length; s++) {
			var gid = groupNameToId[segs[s].name];
			if (gid === undefined) continue;
			var idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			var intensities = new Float32Array(idx.length);
			for (var k = 0; k < idx.length; k++) {
				intensities[k] = segs[s].intensity;
			}
			worker.postMessage({type: 'stimulate', indices: idx, intensities: intensities});
		}
	}

	function sendStimulation() {
		if (!worker) return;

		var segs = collectStimulationSegments();

		var totalLen = 0;
		var indexedSegs = [];
		for (var i = 0; i < segs.length; i++) {
			var gid = groupNameToId[segs[i].name];
			if (gid === undefined) continue;
			var idx = groupIndices[gid];
			if (!idx || idx.length === 0) continue;
			indexedSegs.push({indices: idx, intensity: segs[i].intensity});
			totalLen += idx.length;
		}

		if (totalLen === 0) {
			worker.postMessage({type: 'setStimulusState', indices: null, intensities: null});
			return;
		}

		var allIndices = new Uint32Array(totalLen);
		var allIntensities = new Float32Array(totalLen);
		var offset = 0;
		for (var s = 0; s < indexedSegs.length; s++) {
			var seg = indexedSegs[s];
			allIndices.set(seg.indices, offset);
			for (var k = 0; k < seg.indices.length; k++) {
				allIntensities[offset + k] = seg.intensity;
			}
			offset += seg.indices.length;
		}

		worker.postMessage({type: 'setStimulusState', indices: allIndices, intensities: allIntensities});
	}

	function aggregateFireState() {
		var groupFires = new Float32Array(groupCount);
		var tickWindow = pendingWorkerTicks;

		if (pendingGroupSpikes && pendingWorkerTicks > 0) {
			groupFires.set(pendingGroupSpikes);
		} else if (latestFireState) {
			var fire = latestFireState;
			tickWindow = 1;
			for (var i = 0; i < neuronCount; i++) {
				if (fire[i]) {
					groupFires[groupIdArr[i]]++;
				}
			}
		}

		if (tickWindow < 1) tickWindow = 1;

		for (var g = 0; g < groupCount; g++) {
			var name = groupIdToName[g];
			if (!name || !BRAIN.postSynaptic[name]) continue;
			var size = groupSizes[g];
			var windowActivation = size > 0
				? (groupFires[g] / (size * tickWindow)) * FIRE_STATE_SCALE
				: 0;
			var prevActivation = BRAIN.postSynaptic[name][BRAIN.thisState] || 0;
			var activation = Math.max(windowActivation, prevActivation * 0.75);
			BRAIN.postSynaptic[name][BRAIN.nextState] = activation;
		}

		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		latestFireState = null;
	}

	function stopWorker() {
		if (!workerReady || !worker) return;
		worker.postMessage({type: 'stop'});
		worker.postMessage({type: 'setStimulusState', indices: null, intensities: null});
		latestFireState = null;
		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		BRAIN.latestFireState = null;
		pendingDriveFrames = 0;
	}

	function startWorker() {
		if (!workerReady || !worker) return;
		worker.postMessage({type: 'reset'});
		if (pendingGroupSpikes) pendingGroupSpikes.fill(0);
		pendingWorkerTicks = 0;
		pendingDriveFrames = 0;
		worker.postMessage({type: 'start'});
	}

	BRAIN.stopWorker = stopWorker;
	BRAIN.startWorker = startWorker;

	if (BRAIN._testMode) {
		BRAIN._bridge = {
			synthesizeMotorOutputs: synthesizeMotorOutputs,
			aggregateFireState: aggregateFireState,
			buildGroupIndices: buildGroupIndices,
			collectStimulationSegments: collectStimulationSegments,
			collectOneShotSegments: collectOneShotSegments,
			workerUpdate: workerUpdate,
			FIRE_STATE_SCALE: FIRE_STATE_SCALE,
			MOTOR_SCALE: MOTOR_SCALE,
			STIM_INTENSITY: STIM_INTENSITY,
			_setGroupState: function (gc, nc, gIdArr, gSizes, gIdToNameArr) {
				groupCount = gc;
				neuronCount = nc;
				groupIdArr = gIdArr;
				groupSizes = gSizes;
				groupIdToName = gIdToNameArr;
				groupNameToId = {};
				for (var i = 0; i < gIdToNameArr.length; i++) {
					if (gIdToNameArr[i]) groupNameToId[gIdToNameArr[i]] = i;
				}
				pendingGroupSpikes = new Float32Array(gc);
				pendingWorkerTicks = 0;
				pendingDriveFrames = 0;
			},
			_setFireState: function (fireState, spikes, ticks) {
				latestFireState = fireState;
				if (spikes) pendingGroupSpikes = spikes;
				pendingWorkerTicks = ticks;
			},
			_getGroupIndices: function () {
				return groupIndices;
			},
		};
	} else {
		initBridge();
	}

})();
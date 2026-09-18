// ============================================================
// fisHKA-main-v4.js — с groupFeatures, driveDelta, activityPhase
// ============================================================

var FisHKA_Main = {
    window: 100,
    updateEvery: 10,
    tickCounter: 0,
    STORAGE_KEY: 'fishka_attractors_v2',

    driveNames: ['hunger', 'fear', 'fatigue', 'curiosity', 'groom'],
    accumNames: ['accumStartle', 'accumFlight', 'accumFeed',
                 'accumGroom', 'accumWalkLeft', 'accumWalkRight', 'accumHead'],

    driveHistory: [],
    accumHistory: [],
    drivePCM: null,
    accumPCM: null,
    driveFeatures: { Tr: 0, Frob: 0, R: 0, entropy: 0 },
    accumFeatures: { Tr: 0, Frob: 0, R: 0, entropy: 0 },
    attractors: [],
    currentBehavior: 'idle',

    groupPCM_mag: null,
    groupPCM_phase: null,
    holoMode: 'magnitude',
    canvas: null,
    ctx: null,

    groupFeatures: null,

    init: function () {
        this.loadFromStorage();
        this.drivePCM = this.makeZeroMatrix(this.driveNames.length);
        this.accumPCM = this.makeZeroMatrix(this.accumNames.length);

        this.createHologramCanvas();

        console.log('[FisHKA v4] Initialized. Attractors:', this.attractors.length);
        this.renderUI();
    },

    createHologramCanvas: function () {
        var panel = document.getElementById('fishka-panel');
        if (!panel) return;

        var existing = document.getElementById('fishka-hologram');
        if (existing) existing.remove();

        var canvas = document.createElement('canvas');
        canvas.id = 'fishka-hologram';
        canvas.width = 280;
        canvas.height = 280;
        canvas.style.cssText = 'display:block;margin:8px 0;border:1px solid #0f0;background:#000;image-rendering:pixelated;';
        panel.appendChild(canvas);
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        var btn = document.createElement('button');
        btn.textContent = 'Mode: |Q|';
        btn.onclick = function() {
            FisHKA_Main.holoMode = (FisHKA_Main.holoMode === 'magnitude') ? 'phase' : 'magnitude';
            btn.textContent = 'Mode: ' + (FisHKA_Main.holoMode === 'magnitude' ? '|Q|' : 'arg(Q)');
            FisHKA_Main.drawHologram();
        };
        panel.appendChild(btn);
    },

    makeZeroMatrix: function (n) {
        var M = [];
        for (var i = 0; i < n; i++) M.push(new Array(n).fill(0));
        return M;
    },

    record: function (brain, behaviorState) {
        if (!brain || !brain.drives) return;
        var driveSnapshot = [];
        for (var i = 0; i < this.driveNames.length; i++) {
            var val = brain.drives[this.driveNames[i]];
            driveSnapshot.push(typeof val === 'number' ? val : 0);
        }
        this.driveHistory.push(driveSnapshot);
        if (this.driveHistory.length > this.window) this.driveHistory.shift();

        var accumSnapshot = [];
        for (var i = 0; i < this.accumNames.length; i++) {
            var val = brain[this.accumNames[i]];
            accumSnapshot.push(typeof val === 'number' ? val : 0);
        }
        this.accumHistory.push(accumSnapshot);
        if (this.accumHistory.length > this.window) this.accumHistory.shift();

        if (behaviorState) this.currentBehavior = behaviorState;
        this.tickCounter++;
    },

    computePCM: function (history) {
        var n = history[0].length;
        var T = history.length;
        if (T < 20) return null;

        var means = new Array(n).fill(0);
        for (var t = 0; t < T; t++)
            for (var i = 0; i < n; i++)
                means[i] += history[t][i];
        for (var i = 0; i < n; i++) means[i] /= T;

        var phases = [];
        for (var t = 0; t < T; t++) {
            var row = [];
            for (var i = 0; i < n; i++) {
                var x = history[t][i] - means[i];
                var dx = (t > 0) ? history[t][i] - history[t-1][i] : 0;
                row.push(Math.atan2(x, dx + 1e-6));
            }
            phases.push(row);
        }

        var PCM = [];
        for (var i = 0; i < n; i++) {
            var rowPCM = [];
            for (var j = 0; j < n; j++) {
                var sumRe = 0, sumIm = 0;
                for (var t = 0; t < T; t++) {
                    var ai = history[t][i];
                    var aj = history[t][j];
                    var dphi = phases[t][j] - phases[t][i];
                    sumRe += ai * aj * Math.cos(dphi);
                    sumIm += ai * aj * Math.sin(dphi);
                }
                rowPCM.push({
                    re: sumRe / T, im: sumIm / T,
                    abs: Math.sqrt(sumRe*sumRe + sumIm*sumIm) / T
                });
            }
            PCM.push(rowPCM);
        }
        return PCM;
    },

    computeFeatures: function (PCM) {
        if (!PCM) return { Tr: 0, Frob: 0, R: 0, entropy: 0 };
        var n = PCM.length;
        var Tr = 0, FrobSq = 0;
        var absValues = [];
        for (var i = 0; i < n; i++) {
            Tr += PCM[i][i].re;
            for (var j = 0; j < n; j++) {
                FrobSq += PCM[i][j].re * PCM[i][j].re + PCM[i][j].im * PCM[i][j].im;
                absValues.push(PCM[i][j].abs);
            }
        }
        var Frob = Math.sqrt(FrobSq);
        var R = 0;
        for (var i = 0; i < n; i++) {
            var re = 0, im = 0;
            for (var j = 0; j < n; j++) {
                re += PCM[i][j].re; im += PCM[i][j].im;
            }
            R += Math.sqrt(re*re + im*im);
        }
        R /= (n * n);
        var sumAbs = absValues.reduce(function(a,b){return a+b;}, 0);
        var entropy = 0;
        if (sumAbs > 0) {
            for (var k = 0; k < absValues.length; k++) {
                var p = absValues[k] / sumAbs;
                if (p > 1e-9) entropy -= p * Math.log(p);
            }
        }
        return { Tr: Tr, Frob: Frob, R: R, entropy: entropy };
    },

    update: function (brain, behaviorState) {
        this.record(brain, behaviorState);
        if (this.tickCounter % this.updateEvery === 0 && this.driveHistory.length >= 20) {
            this.drivePCM = this.computePCM(this.driveHistory);
            this.driveFeatures = this.computeFeatures(this.drivePCM);
            this.accumPCM = this.computePCM(this.accumHistory);
            this.accumFeatures = this.computeFeatures(this.accumPCM);
            this.renderUI();
        }
    },

    updateHologram: function (mag, phase, features) {
        this.groupPCM_mag = mag;
        this.groupPCM_phase = phase;
        if (features) this.groupFeatures = features;
        this.drawHologram();
    },

    drawHologram: function () {
        if (!this.ctx || !this.groupPCM_mag) return;
        var n = this.groupPCM_mag.length;
        var size = this.canvas.width;
        var cell = Math.floor(size / n);
        var data = (this.holoMode === 'magnitude') ? this.groupPCM_mag : this.groupPCM_phase;
        if (!data || n === 0) return;

        var values = [];
        for (var i = 0; i < n; i++) {
            for (var j = 0; j < n; j++) {
                var v = data[i][j];
                if (this.holoMode === 'magnitude') {
                    if (v > 1e-6) values.push(Math.log10(v));
                } else {
                    values.push(v);
                }
            }
        }

        if (values.length === 0) {
            this.ctx.fillStyle = 'black';
            this.ctx.fillRect(0, 0, size, size);
            this.lastRange = { nonzero: 0, total: n * n };
            return;
        }

        values.sort(function(a, b) { return a - b; });

        var qLow = values[Math.floor(values.length * 0.05)];
        var qHigh = values[Math.floor(values.length * 0.95)];
        var range = qHigh - qLow;
        if (range < 1e-6) range = 1e-6;

        for (var i = 0; i < n; i++) {
            for (var j = 0; j < n; j++) {
                var v = data[i][j];
                var color;

                if (this.holoMode === 'magnitude') {
                    if (v <= 1e-6) {
                        color = 'rgb(0,0,0)';
                    } else {
                        var norm = (Math.log10(v) - qLow) / range;
                        norm = Math.max(0, Math.min(1, norm));
                        var r = Math.min(255, norm * 2 * 255);
                        var g = Math.min(255, Math.max(0, (norm - 0.5) * 2 * 255));
                        var b = Math.min(255, Math.max(0, (norm - 0.85) * 6 * 255));
                        color = 'rgb(' + Math.floor(r) + ',' + Math.floor(g) + ',' + Math.floor(b) + ')';
                    }
                } else {
                    var normP = (v + Math.PI) / (2 * Math.PI);
                    var hue = normP * 360;
                    color = 'hsl(' + hue + ',100%,50%)';
                }
                this.ctx.fillStyle = color;
                this.ctx.fillRect(j * cell, i * cell, cell, cell);
            }
        }

        this.lastRange = {
            nonzero: values.length,
            total: n * n,
            qLow: qLow,
            qHigh: qHigh
        };
        if (!this._holoCount) this._holoCount = 0;
        this._holoCount++;
        if (this._holoCount % 200 === 0) {
            console.log('[FisHKA] Hologram #' + this._holoCount,
                        'nonzero:', values.length + '/' + (n * n),
                        'range: [' + qLow.toFixed(2) + ', ' + qHigh.toFixed(2) + ']');
        }
    },

    _computeActivityPhase: function () {
        var H = this.accumHistory;
        if (!H || H.length < 5) return 'unknown';

        var sums = [];
        for (var t = 0; t < H.length; t++) {
            var s = 0;
            for (var k = 0; k < H[t].length; k++) s += H[t][k];
            sums.push(s);
        }

        var tail = sums.slice(-5);
        var tailMean = tail.reduce(function(a,b){return a+b;},0) / tail.length;

        var slope = 0;
        for (var t = 1; t < tail.length; t++) slope += tail[t] - tail[t-1];
        slope /= (tail.length - 1);

        var threshold = 0.05 * (tailMean + 1e-6);
        if (slope > threshold) return 'rising';
        if (slope < -threshold) return 'falling';
        return 'stable';
    },

    saveAttractor: function (name) {
        var now = Date.now();

        var last = this.attractors[this.attractors.length - 1];
        if (last && (now - last.timestamp) < 2000 &&
            last.behavior === this.currentBehavior) {
            console.warn('[FisHKA v4] Skipping duplicate (within 2s, same behavior)');
            return null;
        }

        var driveDelta = [];
        if (this.driveHistory.length >= 2) {
            var first = this.driveHistory[0];
            var lastD = this.driveHistory[this.driveHistory.length - 1];
            for (var k = 0; k < first.length; k++) {
                driveDelta.push(lastD[k] - first[k]);
            }
        }

        var accumTail = this.accumHistory.slice(-10).map(function (row) {
            return row.slice();
        });

        var activityPhase = this._computeActivityPhase();

        var gf = this.groupFeatures
            ? JSON.parse(JSON.stringify(this.groupFeatures))
            : null;

        var att = {
            name: name || ('attractor_' + this.attractors.length),
            timestamp: now,
            behavior: this.currentBehavior,

            drives: this.driveHistory[this.driveHistory.length - 1].slice(),
            drivePCM: JSON.parse(JSON.stringify(this.drivePCM)),
            driveFeatures: JSON.parse(JSON.stringify(this.driveFeatures)),
            accumFeatures: JSON.parse(JSON.stringify(this.accumFeatures)),

            groupFeatures: gf,
            driveDelta: driveDelta,
            accumHistoryTail: accumTail,
            activityPhase: activityPhase
        };

        this.attractors.push(att);
        this.saveToStorage();

        var gfLog = gf
            ? ('Tr=' + gf.Tr.toFixed(1) +
               ' nz=' + (gf.nonZeroFraction !== undefined ? gf.nonZeroFraction.toFixed(4) : 'n/a'))
            : 'none';

        console.log('[FisHKA v4] Attractor saved:',
                    att.name,
                    '| behavior:', att.behavior,
                    '| phase:', att.activityPhase,
                    '| gf:', gfLog);

        this.renderUI();
        return att;
    },

    saveToStorage: function () {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.attractors));
        } catch (e) {
            console.error('[FisHKA v4] Storage failed:', e);
        }
    },

    loadFromStorage: function () {
        try {
            var saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) this.attractors = JSON.parse(saved);
        } catch (e) {
            console.error('[FisHKA v4] Load failed:', e);
        }
    },

    exportJSON: function () {
        var data = {
            timestamp: new Date().toISOString(),
            attractors: this.attractors,
            driveHistory: this.driveHistory,
            accumHistory: this.accumHistory
        };
        var blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'fishka_data_' + Date.now() + '.json';
        a.click();
        URL.revokeObjectURL(url);
        console.log('[FisHKA v4] Exported');
    },

    clearAll: function () {
        if (!confirm('Удалить все аттракторы?')) return;
        this.attractors = [];
        this.saveToStorage();
        this.renderUI();
        console.log('[FisHKA v4] Cleared');
    },

    renderUI: function () {
        var el = document.getElementById('fishka-panel');
        if (!el) return;
        var canvas = document.getElementById('fishka-hologram');
        var btn = el.querySelector('button:last-child');

        var html = '<h3 style="margin:0 0 5px 0;color:#0f0;">FisHKA v4</h3>';
        html += '<div><b>Behavior:</b> ' + this.currentBehavior + '</div>';
        html += '<div><b>Drives:</b> Tr=' + this.driveFeatures.Tr.toFixed(2) +
                ', R=' + this.driveFeatures.R.toFixed(3) + '</div>';
        html += '<div><b>Accums:</b> Tr=' + this.accumFeatures.Tr.toFixed(2) +
                ', R=' + this.accumFeatures.R.toFixed(3) + '</div>';

        if (this.groupFeatures) {
            html += '<div><b>Groups:</b> Tr=' + this.groupFeatures.Tr.toFixed(1) +
                    ', nz=' + (this.groupFeatures.nonZeroFraction !== undefined
                               ? this.groupFeatures.nonZeroFraction.toFixed(4)
                               : 'n/a') + '</div>';
        } else {
            html += '<div><b>Groups:</b> <i>waiting...</i></div>';
        }

        html += '<div><b>Attractors:</b> ' + this.attractors.length + '</div>';
        html += '<button onclick="FisHKA_Main.saveAttractor()" style="margin:2px;">Save</button>';
        html += '<button onclick="FisHKA_Main.exportJSON()" style="margin:2px;">Export</button>';
        html += '<button onclick="FisHKA_Main.clearAll()" style="margin:2px;">Clear</button>';

        el.innerHTML = html;
        if (canvas) el.appendChild(canvas);
        if (btn) el.appendChild(btn);
    }
};

window.addEventListener('load', function () {
    setTimeout(function () { FisHKA_Main.init(); }, 500);
});
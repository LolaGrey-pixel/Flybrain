// ============================================================
// fisHKA-worker-v3.js — расширенные groupFeatures (7 полей)
// ============================================================

var FisHKA_Worker = {
    window: 100,
    updateEvery: 20,
    tickCounter: 0,
    groupHistory: [],
    numGroups: 0,
    groupPCM: null,
    groupFeatures: {
        Tr: 0,
        Frob: 0,
        R: 0,
        entropy: 0,
        nonZeroFraction: 0,
        offDiagMean: 0,
        offDiagStd: 0
    },
    lastUpdateTick: 0,

    init: function (numGroups) {
        this.numGroups = numGroups;
        this.groupHistory = [];
        this.tickCounter = 0;
        this.groupPCM = [];
        for (var i = 0; i < numGroups; i++) {
            this.groupPCM.push(new Array(numGroups).fill(0));
        }
        console.log('[FisHKA-worker v3] Initialized for', numGroups, 'groups');
    },

    record: function (groupSpikeCounts) {
        if (!groupSpikeCounts) return;
        var snapshot = [];
        for (var g = 0; g < this.numGroups; g++) {
            snapshot.push(groupSpikeCounts[g] || 0);
        }
        this.groupHistory.push(snapshot);
        if (this.groupHistory.length > this.window) this.groupHistory.shift();
        this.tickCounter++;
    },

    computePCM: function () {
        var n = this.numGroups;
        var T = this.groupHistory.length;
        if (T < 20) return null;

        var means = new Array(n).fill(0);
        for (var t = 0; t < T; t++)
            for (var i = 0; i < n; i++)
                means[i] += this.groupHistory[t][i];
        for (var i = 0; i < n; i++) means[i] /= T;

        var phases = [];
        for (var t = 0; t < T; t++) {
            var row = [];
            for (var i = 0; i < n; i++) {
                var x = this.groupHistory[t][i] - means[i];
                var dx = (t > 0) ? this.groupHistory[t][i] - this.groupHistory[t-1][i] : 0;
                row.push(Math.atan2(x, dx + 1e-6));
            }
            phases.push(row);
        }

        var sumRe = [];
        var sumIm = [];
        for (var i = 0; i < n; i++) {
            sumRe.push(new Array(n).fill(0));
            sumIm.push(new Array(n).fill(0));
        }
        for (var t = 0; t < T; t++) {
            for (var i = 0; i < n; i++) {
                var ai = this.groupHistory[t][i];
                for (var j = 0; j < n; j++) {
                    var aj = this.groupHistory[t][j];
                    var dphi = phases[t][j] - phases[t][i];
                    sumRe[i][j] += ai * aj * Math.cos(dphi);
                    sumIm[i][j] += ai * aj * Math.sin(dphi);
                }
            }
        }

        var mag = [];
        var phase = [];
        for (var i = 0; i < n; i++) {
            mag.push(new Array(n).fill(0));
            phase.push(new Array(n).fill(0));
            for (var j = 0; j < n; j++) {
                var re = sumRe[i][j] / T;
                var im = sumIm[i][j] / T;
                mag[i][j] = Math.sqrt(re*re + im*im);
                phase[i][j] = Math.atan2(im, re);
            }
        }

        return { mag: mag, phase: phase };
    },

    computeFeatures: function (pcm) {
        if (!pcm || !pcm.mag) {
            return {
                Tr: 0, Frob: 0, R: 0,
                entropy: 0, nonZeroFraction: 0,
                offDiagMean: 0, offDiagStd: 0
            };
        }
        var n = this.numGroups;
        var Tr = 0, FrobSq = 0;
        var absValues = [];
        var offDiag = [];
        var nonZeroCount = 0;

        for (var i = 0; i < n; i++) {
            Tr += pcm.mag[i][i];
            for (var j = 0; j < n; j++) {
                var v = pcm.mag[i][j];
                FrobSq += v * v;
                absValues.push(v);
                if (v > 1e-6) nonZeroCount++;
                if (i !== j) offDiag.push(v);
            }
        }
        var Frob = Math.sqrt(FrobSq);

        var R = 0;
        for (var i = 0; i < n; i++) {
            var sumReI = 0, sumImI = 0;
            for (var j = 0; j < n; j++) {
                sumReI += pcm.mag[i][j] * Math.cos(pcm.phase[i][j]);
                sumImI += pcm.mag[i][j] * Math.sin(pcm.phase[i][j]);
            }
            R += Math.sqrt(sumReI * sumReI + sumImI * sumImI);
        }
        R /= (n * n);

        var sumAbs = 0;
        for (var k = 0; k < absValues.length; k++) sumAbs += absValues[k];
        var entropy = 0;
        if (sumAbs > 0) {
            for (var k = 0; k < absValues.length; k++) {
                var p = absValues[k] / sumAbs;
                if (p > 1e-9) entropy -= p * Math.log(p);
            }
        }

        var offDiagMean = 0, offDiagStd = 0;
        if (offDiag.length > 0) {
            var s = 0;
            for (var k = 0; k < offDiag.length; k++) s += offDiag[k];
            offDiagMean = s / offDiag.length;
            var s2 = 0;
            for (var k = 0; k < offDiag.length; k++) {
                var d = offDiag[k] - offDiagMean;
                s2 += d * d;
            }
            offDiagStd = Math.sqrt(s2 / offDiag.length);
        }

        this.groupFeatures = {
            Tr: Tr,
            Frob: Frob,
            R: R,
            entropy: entropy,
            nonZeroFraction: nonZeroCount / (n * n),
            offDiagMean: offDiagMean,
            offDiagStd: offDiagStd
        };
        return this.groupFeatures;
    },

    update: function (groupSpikeCounts) {
        this.record(groupSpikeCounts);
        if (this.tickCounter % this.updateEvery === 0 &&
            this.groupHistory.length >= 20) {
            var pcm = this.computePCM();
            this.computeFeatures(pcm);
            this.lastUpdateTick = this.tickCounter;
            return { features: this.groupFeatures, pcm: pcm };
        }
        return null;
    }
};
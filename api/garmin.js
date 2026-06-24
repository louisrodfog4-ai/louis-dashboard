const { GarminConnect } = require('garmin-connect');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (!email || !password) {
    return res.status(500).json({ error: 'Garmin credentials not configured in environment variables.' });
  }

  try {
    const gc = new GarminConnect({ username: email, password });
    await gc.login(email, password);

    const today = new Date().toISOString().slice(0, 10);

    const [bbResult, sleepResult, stressResult, hrvResult, summaryResult, respResult] =
      await Promise.allSettled([
        gc.getBodyBattery(today, today),
        gc.getSleepData(today),
        gc.getDailyStressLevel(today),
        gc.getHrvData(today),
        gc.getUserSummary(today),
        gc.getRespAverageData(today, today)
      ]);

    // Body battery
    let bodyBattery = null;
    if (bbResult.status === 'fulfilled' && bbResult.value?.[0]?.bodyBatteryValues?.length) {
      const vals = bbResult.value[0].bodyBatteryValues.map(v => v.value).filter(v => v != null);
      if (vals.length) bodyBattery = { current: vals[vals.length - 1], max: Math.max(...vals), min: Math.min(...vals) };
    }

    // Sleep
    let sleep = null;
    if (sleepResult.status === 'fulfilled' && sleepResult.value?.dailySleepDTO) {
      const s = sleepResult.value.dailySleepDTO;
      sleep = {
        score: s.sleepScores?.overall?.value ?? null,
        hours: s.sleepTimeSeconds != null ? +(s.sleepTimeSeconds / 3600).toFixed(1) : null,
        stages: {
          deep: s.deepSleepSeconds != null ? +(s.deepSleepSeconds / 3600).toFixed(2) : null,
          rem: s.remSleepSeconds != null ? +(s.remSleepSeconds / 3600).toFixed(2) : null,
          light: s.lightSleepSeconds != null ? +(s.lightSleepSeconds / 3600).toFixed(2) : null,
          awake: s.awakeSleepSeconds != null ? +(s.awakeSleepSeconds / 3600).toFixed(2) : null
        }
      };
    }

    // Stress
    let stress = null;
    if (stressResult.status === 'fulfilled' && stressResult.value?.avgStressLevel != null) {
      stress = { avg: stressResult.value.avgStressLevel };
    }

    // HRV
    let hrv = null;
    if (hrvResult.status === 'fulfilled' && hrvResult.value?.hrvSummary?.lastNight != null) {
      hrv = { value: hrvResult.value.hrvSummary.lastNight, status: hrvResult.value.hrvSummary.status ?? null };
    }

    // User summary
    let steps = null, restingHeartRate = null, activeCalories = null, activeMinutes = null, distance = null;
    if (summaryResult.status === 'fulfilled' && summaryResult.value) {
      const s = summaryResult.value;
      steps = { count: s.totalSteps ?? null, goal: s.dailyStepGoal ?? null };
      restingHeartRate = s.restingHeartRate ?? null;
      activeCalories = s.activeKilocalories ?? null;
      activeMinutes = s.activeTimeSeconds != null ? Math.round(s.activeTimeSeconds / 60) : null;
      distance = s.totalDistanceMeters ?? null;
    }

    // Respiration
    let respiration = null;
    if (respResult.status === 'fulfilled' && respResult.value) {
      const r = respResult.value;
      const avg = r.avgWakingRespirationValue ?? r.avgRespirationValue ?? r.averageRespirationValue ?? null;
      if (avg != null) respiration = { avg };
    }

    const todayCall = recommend({ bodyBattery, hrv, sleep, stress });

    return res.json({
      bodyBattery,
      sleep,
      hrv,
      restingHeartRate,
      stress,
      respiration,
      steps,
      activeCalories,
      activeMinutes,
      distance,
      todayCall,
      fetchedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Garmin error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function recommend({ bodyBattery, hrv, sleep, stress }) {
  const bb = bodyBattery?.current;
  const score = sleep?.score;
  const avg = stress?.avg;

  if (bb != null && bb < 25) return 'Very low body battery — rest day recommended, avoid intense training.';
  if (bb != null && bb < 45) return 'Low body battery — keep training light today and prioritise recovery.';
  if (avg != null && avg > 75) return 'High stress detected — consider a recovery session or rest day today.';
  if (score != null && score < 55) return 'Poor sleep last night — keep training intensity moderate today.';
  if (bb != null && bb >= 75 && (score == null || score >= 70)) return 'Great recovery — push hard in training today.';
  if (bb != null && bb >= 50) return 'Good recovery — moderate to high intensity training is fine today.';
  return 'Sync your Garmin watch for a personalised training recommendation.';
}

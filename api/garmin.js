const { GarminConnect } = require('garmin-connect');

const GC_API = 'https://connectapi.garmin.com';

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
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const profile = await gc.getUserProfile();
    const displayName = profile.displayName;

    const [bbRes, sleepRes, stressRes, hrvRes, hrRes, stepsRes, summaryRes, respRes] =
      await Promise.allSettled([
        gc.client.get(`${GC_API}/wellness-service/wellness/dailyBodyBattery/${displayName}`, { params: { startDate: today, endDate: today } }),
        gc.getSleepData(new Date(yesterday)),
        gc.client.get(`${GC_API}/wellness-service/wellness/dailyStress/${today}`),
        gc.client.get(`${GC_API}/hrv-service/hrv/${today}`),
        gc.getHeartRate(new Date(today)),
        gc.getSteps(new Date(today)),
        gc.client.get(`${GC_API}/usersummary-service/usersummary/daily/${displayName}`, { params: { calendarDate: today } }),
        gc.client.get(`${GC_API}/wellness-service/wellness/dailyRespiration/${today}`)
      ]);

    // Body battery
    let bodyBattery = null;
    if (bbRes.status === 'fulfilled' && Array.isArray(bbRes.value) && bbRes.value[0]?.bodyBatteryValues?.length) {
      const vals = bbRes.value[0].bodyBatteryValues.map(v => v.value).filter(v => v != null);
      if (vals.length) bodyBattery = { current: vals[vals.length - 1], max: Math.max(...vals), min: Math.min(...vals) };
    }

    // Sleep
    let sleep = null;
    if (sleepRes.status === 'fulfilled' && sleepRes.value?.dailySleepDTO) {
      const s = sleepRes.value.dailySleepDTO;
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
    if (stressRes.status === 'fulfilled' && stressRes.value?.avgStressLevel != null) {
      stress = { avg: stressRes.value.avgStressLevel };
    }

    // HRV
    let hrv = null;
    if (hrvRes.status === 'fulfilled' && hrvRes.value?.hrvSummary?.lastNight != null) {
      hrv = { value: hrvRes.value.hrvSummary.lastNight, status: hrvRes.value.hrvSummary.status ?? null };
    }

    // Resting heart rate
    let restingHeartRate = null;
    if (hrRes.status === 'fulfilled' && hrRes.value?.restingHeartRate != null) {
      restingHeartRate = hrRes.value.restingHeartRate;
    }

    // Steps
    let steps = null;
    if (stepsRes.status === 'fulfilled' && stepsRes.value) {
      const s = stepsRes.value;
      steps = { count: s.totalSteps ?? null, goal: s.stepGoal ?? null };
    }

    // User summary (calories, active minutes, distance)
    let activeCalories = null, activeMinutes = null, distance = null;
    if (summaryRes.status === 'fulfilled' && summaryRes.value) {
      const s = summaryRes.value;
      activeCalories = s.activeKilocalories ?? null;
      activeMinutes = s.activeTimeSeconds != null ? Math.round(s.activeTimeSeconds / 60) : null;
      distance = s.totalDistanceMeters ?? null;
      if (restingHeartRate == null) restingHeartRate = s.restingHeartRate ?? null;
    }

    // Respiration
    let respiration = null;
    if (respRes.status === 'fulfilled' && respRes.value) {
      const r = respRes.value;
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

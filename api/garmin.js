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

  // Use client-supplied local dates so NZ timezone is correct
  const today     = req.query.date      || new Date().toISOString().slice(0, 10);
  const yesterday = req.query.yesterday || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const debug     = req.query.debug === '1';

  try {
    const gc = new GarminConnect({ username: email, password });
    await gc.login(email, password);

    const profile = await gc.getUserProfile();
    const displayName = profile.displayName;

    const [bbRes, sleepRes, sleepRawRes, sleepTodayRes, stressRes, hrvRes, hrRes, stepsRes, summaryRes, respRes] =
      await Promise.allSettled([
        gc.client.get(`${GC_API}/wellness-service/wellness/dailyBodyBattery/${displayName}`, { params: { startDate: today, endDate: today } }),
        gc.getSleepData(new Date(yesterday)),
        gc.client.get(`${GC_API}/wellness-service/wellness/sleep/${yesterday}`),
        gc.getSleepData(new Date(today)),
        gc.client.get(`${GC_API}/wellness-service/wellness/dailyStress/${today}`),
        gc.client.get(`${GC_API}/hrv-service/hrv/${today}`),
        gc.getHeartRate(new Date(today)),
        gc.getSteps(new Date(today)),
        gc.client.get(`${GC_API}/usersummary-service/usersummary/daily/${displayName}`, { params: { calendarDate: today } }),
        gc.client.get(`${GC_API}/wellness-service/wellness/dailyRespiration/${today}`)
      ]);

    if (debug) {
      return res.json({
        dates: { today, yesterday },
        bodyBattery:   { status: bbRes.status,         value: bbRes.value         ?? bbRes.reason?.message },
        sleepYesterday:{ status: sleepRes.status,       value: sleepRes.value      ?? sleepRes.reason?.message },
        sleepRaw:      { status: sleepRawRes.status,    value: sleepRawRes.value   ?? sleepRawRes.reason?.message },
        sleepToday:    { status: sleepTodayRes.status,  value: sleepTodayRes.value ?? sleepTodayRes.reason?.message },
        stress:        { status: stressRes.status,      value: stressRes.value     ?? stressRes.reason?.message },
        hrv:           { status: hrvRes.status,         value: hrvRes.value        ?? hrvRes.reason?.message },
        heartRate:     { status: hrRes.status,          value: hrRes.value         ?? hrRes.reason?.message },
        steps:         { status: stepsRes.status,       value: stepsRes.value      ?? stepsRes.reason?.message },
        summary:       { status: summaryRes.status,     value: summaryRes.value    ?? summaryRes.reason?.message },
        respiration:   { status: respRes.status,        value: respRes.value       ?? respRes.reason?.message },
      });
    }

    // Body battery — try dedicated endpoint first, then extract from stress response
    let bodyBattery = null;
    if (bbRes.status === 'fulfilled' && Array.isArray(bbRes.value) && bbRes.value[0]?.bodyBatteryValues?.length) {
      const vals = bbRes.value[0].bodyBatteryValues.map(v => v.value).filter(v => v != null);
      if (vals.length) bodyBattery = { current: vals[vals.length - 1], max: Math.max(...vals), min: Math.min(...vals) };
    }
    // Fallback: extract from stress response bodyBatteryValuesArray
    // Format: [[timestamp, status, level, version], ...] — only rows where status === "MEASURED"
    if (!bodyBattery && stressRes.status === 'fulfilled' && Array.isArray(stressRes.value?.bodyBatteryValuesArray)) {
      const rows = stressRes.value.bodyBatteryValuesArray;
      const descriptors = stressRes.value.bodyBatteryValueDescriptorsDTOList ?? [];
      const levelIdx = descriptors.findIndex(d => d.bodyBatteryValueDescriptorKey === 'bodyBatteryLevel');
      const statusIdx = descriptors.findIndex(d => d.bodyBatteryValueDescriptorKey === 'bodyBatteryStatus');
      const idx = levelIdx >= 0 ? levelIdx : 2;
      const stIdx = statusIdx >= 0 ? statusIdx : 1;
      const vals = rows
        .filter(r => r[stIdx] === 'MEASURED' && r[idx] != null && typeof r[idx] === 'number')
        .map(r => r[idx]);
      if (vals.length) bodyBattery = { current: vals[vals.length - 1], max: Math.max(...vals), min: Math.min(...vals) };
    }

    // Sleep — try yesterday, raw yesterday, and today (Garmin stores under wake date sometimes)
    let sleep = null;
    const sleepData      = sleepRes.status      === 'fulfilled' ? sleepRes.value      : null;
    const sleepRawData   = sleepRawRes.status   === 'fulfilled' ? sleepRawRes.value   : null;
    const sleepTodayData = sleepTodayRes.status === 'fulfilled' ? sleepTodayRes.value : null;

    const dto      = sleepData?.dailySleepDTO      ?? sleepData;
    const rawDto   = sleepRawData?.dailySleepDTO   ?? sleepRawData;
    const todayDto = sleepTodayData?.dailySleepDTO ?? sleepTodayData;

    const s = [todayDto, dto, rawDto].find(d => d?.sleepTimeSeconds != null);
    if (s) {
      sleep = {
        score:  s.sleepScores?.overall?.value ?? s.sleepScore ?? null,
        hours:  s.sleepTimeSeconds != null ? +(s.sleepTimeSeconds / 3600).toFixed(1) : null,
        stages: {
          deep:  s.deepSleepSeconds  != null ? +(s.deepSleepSeconds  / 3600).toFixed(2) : null,
          rem:   s.remSleepSeconds   != null ? +(s.remSleepSeconds   / 3600).toFixed(2) : null,
          light: s.lightSleepSeconds != null ? +(s.lightSleepSeconds / 3600).toFixed(2) : null,
          awake: s.awakeSleepSeconds != null ? +(s.awakeSleepSeconds / 3600).toFixed(2) : null,
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
      const st = stepsRes.value;
      steps = { count: st.totalSteps ?? null, goal: st.stepGoal ?? null };
    }

    // User summary (calories, active minutes, distance)
    let activeCalories = null, activeMinutes = null, distance = null;
    if (summaryRes.status === 'fulfilled' && summaryRes.value) {
      const su = summaryRes.value;
      activeCalories = su.activeKilocalories ?? null;
      activeMinutes  = su.activeTimeSeconds != null ? Math.round(su.activeTimeSeconds / 60) : null;
      distance       = su.totalDistanceMeters ?? null;
      if (restingHeartRate == null) restingHeartRate = su.restingHeartRate ?? null;
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
  const bb    = bodyBattery?.current;
  const score = sleep?.score;
  const avg   = stress?.avg;

  if (bb != null && bb < 25)  return 'Very low body battery — rest day recommended, avoid intense training.';
  if (bb != null && bb < 45)  return 'Low body battery — keep training light today and prioritise recovery.';
  if (avg != null && avg > 75) return 'High stress detected — consider a recovery session or rest day today.';
  if (score != null && score < 55) return 'Poor sleep last night — keep training intensity moderate today.';
  if (bb != null && bb >= 75 && (score == null || score >= 70)) return 'Great recovery — push hard in training today.';
  if (bb != null && bb >= 50) return 'Good recovery — moderate to high intensity training is fine today.';
  return 'Sync your Garmin watch for a personalised training recommendation.';
}

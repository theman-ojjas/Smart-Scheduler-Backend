const dayjs = require("dayjs");

// helper: weekday names mapping
const WEEKDAY_NAME = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function parseDate(s) {
  return dayjs(s, "YYYY-MM-DD", true).isValid() ? dayjs(s, "YYYY-MM-DD") : null;
}

function nextWorkday(date, workDays) {
  let d = date;
  while (!workDays.includes(WEEKDAY_NAME[d.day()])) d = d.add(1, "day");
  return d;
}

// returns {recommendedOrder: [...], schedule: [...], warnings:[], errors:[]}
function scheduleTasks({ tasks, workHoursPerDay = 8, workDays = ["Mon","Tue","Wed","Thu","Fri"], startDate = null }) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be a non-empty array");
  // normalize tasks map
  const taskMap = new Map();
  tasks.forEach(t => {
    if (!t.title || typeof t.estimatedHours !== "number" || t.estimatedHours <= 0) {
      throw new Error(`Each task must have title and positive estimatedHours. Invalid: ${JSON.stringify(t)}`);
    }
    const due = parseDate(t.dueDate);
    if (!due) throw new Error(`Invalid dueDate for task ${t.title}`);
    if (taskMap.has(t.title)) throw new Error(`Duplicate task title: ${t.title}`);
    taskMap.set(t.title, {
      title: t.title,
      estimatedHours: t.estimatedHours,
      dueDate: due,
      dependencies: Array.isArray(t.dependencies) ? t.dependencies.slice() : []
    });
  });

  // validate dependencies refer to valid titles
  for (const [title, t] of taskMap) {
    for (const d of t.dependencies) {
      if (!taskMap.has(d)) throw new Error(`Task "${title}" depends on unknown task "${d}"`);
      if (d === title) throw new Error(`Task "${title}" depends on itself`);
    }
  }

  // Build in-degree and adjacency
  const indeg = new Map();
  const adj = new Map();
  for (const title of taskMap.keys()) {
    indeg.set(title, 0);
    adj.set(title, []);
  }
  for (const [title, t] of taskMap) {
    for (const dep of t.dependencies) {
      adj.get(dep).push(title);
      indeg.set(title, indeg.get(title) + 1);
    }
  }

  // Kahn's algorithm but prioritized by (dueDate asc, estimatedHours desc)
  const cmp = (a,b) => {
    const ta = taskMap.get(a), tb = taskMap.get(b);
    if (ta.dueDate.isBefore(tb.dueDate)) return -1;
    if (ta.dueDate.isAfter(tb.dueDate)) return 1;
    // tie-break: larger estimated first
    if (ta.estimatedHours > tb.estimatedHours) return -1;
    if (ta.estimatedHours < tb.estimatedHours) return 1;
    return a.localeCompare(b);
  };

  // priority queue implemented via array (tasks count small in typical use)
  const available = [];
  for (const [title, deg] of indeg) if (deg === 0) available.push(title);
  available.sort(cmp);

  const topo = [];
  while (available.length > 0) {
    const cur = available.shift();
    topo.push(cur);
    for (const nb of adj.get(cur)) {
      indeg.set(nb, indeg.get(nb) - 1);
      if (indeg.get(nb) === 0) {
        // insert in order
        available.push(nb);
        available.sort(cmp);
      }
    }
  }
  if (topo.length !== taskMap.size) {
    throw new Error("Cycle detected in dependencies");
  }

  // Scheduling: allocate hours starting from startDate (or today)
  const today = startDate ? dayjs(startDate, "YYYY-MM-DD") : dayjs();
  let currentDay = nextWorkday(dayjs(today.format("YYYY-MM-DD")), workDays); // normalize to midnight
  // track per-task remaining hours and earliest available date (after deps finish)
  const remaining = new Map();
  const readyAfter = new Map(); // title -> earliest dayjs when it becomes ready (after dependencies finished)
  for (const [title, t] of taskMap) {
    remaining.set(title, t.estimatedHours);
    readyAfter.set(title, dayjs("1970-01-01")); // epoch => ready immediately unless deps
  }
  // When a task finishes, we set readyAfter for dependents
  const finishedAt = new Map(); // title -> dayjs of finish time

  // For tasks with dependencies, set earliest ready to max of dependencies finish (we'll update as we schedule)
  // We'll schedule tasks in `topo` order, but allow a task to start only after its dependencies finished.
  const schedule = []; // array of {date: 'YYYY-MM-DD', allocations: [{title, hours}]}
  const warnings = [];
  const hoursPerDay = workHoursPerDay;

  // helper to push allocation into schedule for date
  function addAllocation(date, title, hours) {
    const idx = schedule.findIndex(s => s.date === date);
    if (idx === -1) schedule.push({ date, allocations: [{ title, hours }]});
    else schedule[idx].allocations.push({ title, hours });
  }

  // We'll maintain pointer to current day and remaining free hours in that day.
  let freeHoursToday = hoursPerDay;

  // helper to advance to next workday and reset free hours
  function advanceToNextWorkday() {
    currentDay = nextWorkday(currentDay.add(1, "day"), workDays);
    freeHoursToday = hoursPerDay;
  }

  // Maintain map of when dependencies finished (update finishedAt once task fully completed)
  for (const title of topo) {
    // We need to wait until all dependencies finished
    const deps = taskMap.get(title).dependencies;
    let earliestReady = dayjs("1970-01-01");
    if (deps.length > 0) {
      for (const d of deps) {
        if (!finishedAt.has(d)) {
          // if dependency not yet scheduled, that's a logic error (shouldn't happen because topo)
          earliestReady = dayjs.max ? dayjs.max(earliestReady, dayjs()) : dayjs(); // fallback
        } else {
          if (finishedAt.get(d).isAfter(earliestReady)) earliestReady = finishedAt.get(d);
        }
      }
    }
    // set currentDay at least earliestReady (if earliestReady is later than currentDay, advance days)
    // If earliestReady is same day but later (we don't track hours-of-day timestamps), we allow continuing that day if finished that morning.
    if (earliestReady.isAfter(currentDay)) {
      // move currentDay forward to earliestReady (rounded to start-of-day)
      currentDay = nextWorkday(earliestReady, workDays);
      freeHoursToday = hoursPerDay;
    }

    // Now allocate hours for this task across available days starting from currentDay
    let rem = remaining.get(title);
    while (rem > 0) {
      // if current day is after dueDate -> warning maybe
      const taskDue = taskMap.get(title).dueDate;
      // If taskDue is before currentDay and rem>0, we still allocate but mark warning
      if (currentDay.isAfter(taskDue) && rem > 0) {
        warnings.push(`Task "${title}" cannot be finished before its dueDate ${taskDue.format("YYYY-MM-DD")}. Earliest possible finish will be after ${currentDay.format("YYYY-MM-DD")}.`);
      }

      // If free hours zero, advance
      if (freeHoursToday <= 0) {
        advanceToNextWorkday();
        continue;
      }
      // allocate min(freeHoursToday, rem)
      const alloc = Math.min(freeHoursToday, rem);
      addAllocation(currentDay.format("YYYY-MM-DD"), title, alloc);
      rem -= alloc;
      freeHoursToday -= alloc;
      // if rem > 0, need to advance to next workday
      if (rem > 0) {
        advanceToNextWorkday();
      }
    } // while rem>0
    // mark finishedAt for this task as the day it last had allocation
    // find last day in schedule where this task appears
    const lastDayRecord = [...schedule].reverse().find(r => r.allocations.some(a => a.title === title));
    finishedAt.set(title, dayjs(lastDayRecord.date));
    // after finishing this task we can continue scheduling next tasks on the same day if freeHoursToday > 0
  }

  // Build recommendedOrder (topo)
  const recommendedOrder = topo;

  return {
    recommendedOrder,
    schedule,
    warnings
  };
}

module.exports = { scheduleTasks };

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors"); // <-- add this
const scheduler = require("./scheduler");

const app = express();
app.use(cors({
  origin: "https://smart-scheduler-frontend-4vfs.vercel.app",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
}));

app.use(bodyParser.json());

app.post("/api/v1/projects/:projectId/schedule", (req, res) => {
  try {
    const projectId = req.params.projectId;
    const body = req.body || {};
    const workHoursPerDay = body.workHoursPerDay || 8;
    const workDays = body.workDays || ["Mon","Tue","Wed","Thu","Fri"];
    const startDate = body.startDate || null;
    const result = scheduler.scheduleTasks({
      tasks: body.tasks || [],
      workHoursPerDay,
      workDays,
      startDate
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || "Bad Request" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Smart Scheduler listening on ${PORT}`));


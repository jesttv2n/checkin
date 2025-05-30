const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Data storage (i produktion: brug database som PostgreSQL eller MongoDB)
let visitors = [];
const DATA_FILE = path.join(__dirname, "data", "visitors.json");

// Middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'", "'unsafe-inline'"],
        "script-src-attr": ["'unsafe-inline'"],
      },
    },
  })
);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutter
  max: 100, // Max 100 requests per IP per 15 min
  message: { error: "For mange anmodninger. Prøv igen senere." },
});
app.use(limiter);

// Strengere rate limiting for registreringer
const registrationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minut
  max: 5, // Max 5 registreringer per IP per minut
  message: { error: "For mange registreringer. Vent venligst." },
});

// Initialiser data storage
async function initializeData() {
  try {
    // Sørg for at data-mappen eksisterer
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

    // Læs eksisterende data hvis filen findes
    try {
      const data = await fs.readFile(DATA_FILE, "utf8");
      visitors = JSON.parse(data);
      console.log(`Indlæst ${visitors.length} eksisterende registreringer`);
    } catch (err) {
      // Filen findes ikke - det er OK
      console.log("Starter med tom database");
      visitors = [];
    }
  } catch (error) {
    console.error("Fejl ved initialisering af data:", error);
    process.exit(1);
  }
}

// Gem data til fil (i produktion: gem til database)
async function saveData() {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(visitors, null, 2));
  } catch (error) {
    console.error("Fejl ved gemning af data:", error);
    throw error;
  }
}

// Generer sikker fingerprint baseret på IP og User-Agent
function generateFingerprint(req) {
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.get("User-Agent") || "";
  const data = `${ip}_${userAgent}`;
  return crypto
    .createHash("sha256")
    .update(data)
    .digest("hex")
    .substring(0, 32);
}

// Valider kommune
function isValidKommune(kommune) {
  const validKommuner = [
    "Aalborg",
    "Brønderslev",
    "Frederikshavn",
    "Hjørring",
    "Jammerbugt",
    "Læsø",
    "Mariagerfjord",
    "Morsø",
    "Rebild",
    "Thisted",
    "Vesthimmerland",
    "Anden del af Danmark",
  ];
  return validKommuner.includes(kommune);
}

// Get dagens dato som streng
function getTodayKey() {
  return new Date().toDateString();
}

// API Routes

// GET /api/stats - Hent statistikker
app.get("/api/stats", (req, res) => {
  try {
    const today = getTodayKey();
    const todayVisitors = visitors.filter((v) => v.date === today);

    // Grundlæggende statistikker
    const todayTotal = todayVisitors.reduce((sum, v) => sum + v.antal, 0);
    const totalVisitors = visitors.reduce((sum, v) => sum + v.antal, 0);

    // Beregn unikke dage
    const uniqueDays = [...new Set(visitors.map((v) => v.date))];
    const totalDays = Math.max(1, uniqueDays.length);
    const avgDaily = Math.round(totalVisitors / totalDays);

    // Kommune-statistikker for i dag
    const kommuneStats = {};
    todayVisitors.forEach((v) => {
      kommuneStats[v.kommune] = (kommuneStats[v.kommune] || 0) + v.antal;
    });

    // Find mest aktive kommune
    const topKommune = Object.keys(kommuneStats).reduce(
      (a, b) => ((kommuneStats[a] || 0) > (kommuneStats[b] || 0) ? a : b),
      "Ingen data"
    );

    // Seneste registrering
    let lastRegistration = "Ingen endnu";
    if (visitors.length > 0) {
      const lastVisitor = visitors[visitors.length - 1];
      lastRegistration = new Date(lastVisitor.timestamp).toLocaleTimeString(
        "da-DK",
        {
          hour: "2-digit",
          minute: "2-digit",
        }
      );
    }

    // Daglig oversigt
    const dailyBreakdown = uniqueDays
      .map((date) => {
        const dayVisitors = visitors.filter((v) => v.date === date);
        const dayTotal = dayVisitors.reduce((sum, v) => sum + v.antal, 0);
        return {
          date,
          count: dayTotal,
          isToday: date === today,
        };
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({
      todayTotal,
      totalVisitors,
      totalDays,
      avgDaily,
      topKommune:
        Object.keys(kommuneStats).length > 0 ? topKommune : "Ingen data",
      lastRegistration,
      kommuneStats,
      dailyBreakdown,
      lastUpdate: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Fejl ved hentning af statistikker:", error);
    res.status(500).json({ error: "Intern serverfejl" });
  }
});

// POST /api/register - Registrer besøg
app.post("/api/register", registrationLimiter, async (req, res) => {
  try {
    const { kommune, antal } = req.body;

    // Validering
    if (!kommune || !isValidKommune(kommune)) {
      return res.status(400).json({ error: "Ugyldig kommune" });
    }

    if (!antal || antal < 1 || antal > 50 || !Number.isInteger(antal)) {
      return res.status(400).json({ error: "Ugyldigt antal (1-50)" });
    }

    // Check for duplikater (samme fingerprint samme dag)
    const fingerprint = generateFingerprint(req);
    const today = getTodayKey();
    const existingToday = visitors.find(
      (v) => v.fingerprint === fingerprint && v.date === today
    );

    if (existingToday) {
      return res.status(409).json({
        error: "Du har allerede registreret dig i dag",
        alreadyRegistered: true,
      });
    }

    // Opret registrering
    const registration = {
      id: Date.now() + Math.random(), // I produktion: brug UUID
      kommune,
      antal,
      timestamp: new Date().toISOString(),
      date: today,
      fingerprint,
      ip: req.ip || req.connection.remoteAddress,
    };

    visitors.push(registration);
    await saveData();

    // Beregn dagens besøgsnummer
    const todayVisitors = visitors.filter((v) => v.date === today);
    const todayCount = todayVisitors.reduce((sum, v) => sum + v.antal, 0);

    console.log(
      `Ny registrering: ${kommune}, ${antal} personer (Total i dag: ${todayCount})`
    );

    res.status(201).json({
      success: true,
      todayCount,
      message: `Registreret som besøgende #${todayCount} i dag fra ${kommune}`,
    });
  } catch (error) {
    console.error("Fejl ved registrering:", error);
    res.status(500).json({ error: "Intern serverfejl" });
  }
});

// POST /api/admin/login - Admin login
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;

  // I produktion: brug sikker autentificering med bcrypt og JWT
  const ADMIN_USER = process.env.ADMIN_USER || "admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "nordjylland2025";

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    // I produktion: generer JWT token
    res.json({
      success: true,
      token: "admin_session_" + Date.now(), // Placeholder
    });
  } else {
    res.status(401).json({ error: "Forkert brugernavn eller adgangskode" });
  }
});

// GET /api/admin/export - Eksporter data (kun admin)
app.get("/api/admin/export", (req, res) => {
  // I produktion: verificer admin-token
  try {
    const exportData = {
      exportDate: new Date().toISOString(),
      totalVisitors: visitors.length,
      data: visitors,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=tv2nord-event-data-${
        new Date().toISOString().split("T")[0]
      }.json`
    );

    res.json(exportData);
  } catch (error) {
    console.error("Fejl ved eksport:", error);
    res.status(500).json({ error: "Fejl ved eksport" });
  }
});

// DELETE /api/admin/clear-today - Slet dagens data (kun til test)
app.delete("/api/admin/clear-today", async (req, res) => {
  // I produktion: verificer admin-token og tilføj ekstra sikkerhed
  try {
    const today = getTodayKey();
    const beforeCount = visitors.length;
    visitors = visitors.filter((v) => v.date !== today);
    const afterCount = visitors.length;

    await saveData();

    console.log(`Slettet ${beforeCount - afterCount} registreringer fra i dag`);

    res.json({
      success: true,
      deletedCount: beforeCount - afterCount,
    });
  } catch (error) {
    console.error("Fejl ved sletning:", error);
    res.status(500).json({ error: "Fejl ved sletning" });
  }
});

// Serve frontend files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/display", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "display.html"));
});

// Error handling
app.use((err, req, res, next) => {
  console.error("Uventet fejl:", err);
  res.status(500).json({ error: "Intern serverfejl" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint ikke fundet" });
});

// Start server
async function startServer() {
  try {
    await initializeData();

    app.listen(PORT, () => {
      console.log(`🚀 TV2 Nord Event Server kører på port ${PORT}`);
      console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
      console.log(`🖥️  Display: http://localhost:${PORT}/display`);
      console.log(`📝 Registrering: http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Fejl ved start af server:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Server lukker ned...");
  await saveData();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Server lukker ned...");
  await saveData();
  process.exit(0);
});

startServer();

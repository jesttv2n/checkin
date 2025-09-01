const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// Database forbindelse til Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Auto-migration ved opstart (kun i produktion)
async function ensureTableStructure() {
  try {
    console.log("🔍 Tjekker database struktur...");

    // Tjek om tabellen eksisterer
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'registrations'
      );
    `);

    if (!tableExists.rows[0].exists) {
      console.log("📋 Opretter ny registrations tabel...");

      // Opret helt ny tabel
      await pool.query(`
        CREATE TABLE registrations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          
          -- Bruger input
          kommune VARCHAR(50),
          antal INTEGER,
          
          -- Validering og status
          is_valid BOOLEAN NOT NULL DEFAULT true,
          validation_errors TEXT[],
          
          -- Tracking data
          ip_address INET,
          user_agent TEXT,
          fingerprint VARCHAR(64),
          
          -- Request metadata
          request_headers JSONB,
          rate_limit_hit BOOLEAN DEFAULT false,
          duplicate_of UUID REFERENCES registrations(id),
          
          -- Timestamps
          created_at TIMESTAMPTZ DEFAULT NOW(),
          date_key DATE DEFAULT CURRENT_DATE,
          
          -- Legacy support
          legacy_timestamp TEXT,
          legacy_date TEXT
        );
      `);

      await createIndices();
      console.log("✅ Ny tabel oprettet");
      return;
    }

    // Tabel eksisterer - tjek om nye kolonner mangler
    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'registrations' 
      AND table_schema = 'public'
      ORDER BY column_name;
    `);

    const existingColumns = columns.rows.map((row) => row.column_name);
    const requiredColumns = {
      is_valid: "BOOLEAN NOT NULL DEFAULT true",
      validation_errors: "TEXT[]",
      request_headers: "JSONB",
      rate_limit_hit: "BOOLEAN DEFAULT false",
      duplicate_of: "UUID REFERENCES registrations(id)",
      date_key: "DATE DEFAULT CURRENT_DATE",
    };

    // Tilføj manglende kolonner
    for (const [columnName, columnDef] of Object.entries(requiredColumns)) {
      if (!existingColumns.includes(columnName)) {
        console.log(`➕ Tilføjer kolonne: ${columnName}`);

        try {
          await pool.query(
            `ALTER TABLE registrations ADD COLUMN ${columnName} ${columnDef}`
          );

          // Hvis det er is_valid, sæt alle eksisterende registreringer til true
          if (columnName === "is_valid") {
            await pool.query(
              `UPDATE registrations SET is_valid = true WHERE is_valid IS NULL`
            );
            console.log(
              "✅ Markerede alle eksisterende registreringer som gyldige"
            );
          }

          // Hvis det er date_key, beregn den fra created_at eller timestamp
          if (columnName === "date_key") {
            await pool.query(`
              UPDATE registrations 
              SET date_key = COALESCE(created_at::date, CURRENT_DATE)
              WHERE date_key IS NULL
            `);
            console.log("✅ Beregnede date_key for eksisterende data");
          }
        } catch (error) {
          console.warn(`⚠️ Kunne ikke tilføje ${columnName}:`, error.message);
        }
      }
    }

    await createIndices();
    console.log("✅ Database struktur er opdateret");
  } catch (error) {
    console.error("❌ Fejl ved database migration:", error);
    // Vi fortsætter alligevel - bedre at køre med manglende felter end at crashe
  }
}

async function createIndices() {
  const indices = [
    "CREATE INDEX IF NOT EXISTS idx_registrations_date_key ON registrations(date_key)",
    "CREATE INDEX IF NOT EXISTS idx_registrations_is_valid ON registrations(is_valid)",
    "CREATE INDEX IF NOT EXISTS idx_registrations_fingerprint ON registrations(fingerprint, date_key)",
    "CREATE INDEX IF NOT EXISTS idx_registrations_ip ON registrations(ip_address, date_key)",
    "CREATE INDEX IF NOT EXISTS idx_registrations_created_at ON registrations(created_at)",
  ];

  for (const indexQuery of indices) {
    try {
      await pool.query(indexQuery);
    } catch (error) {
      // Ignorer fejl - indeks eksisterer måske allerede
    }
  }
}

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

// Rate limiting med forbedret tracking
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "For mange anmodninger. Prøv igen senere." },
  handler: (req, res) => {
    logRegistrationAttempt(
      req,
      null,
      null,
      false,
      ["Rate limit overskredet"],
      true
    );
    res.status(429).json({ error: "For mange anmodninger. Prøv igen senere." });
  },
});
app.use(limiter);

const registrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "For mange registreringer. Vent venligst." },
  handler: (req, res) => {
    logRegistrationAttempt(
      req,
      req.body?.kommune,
      req.body?.antal,
      false,
      ["Registrerings-rate limit overskredet"],
      true
    );
    res.status(429).json({ error: "For mange registreringer. Vent venligst." });
  },
});

// Forbedret IP detektion for Vercel
function getRealIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.ip ||
    "unknown"
  );
}

function generateFingerprint(req) {
  const ip = getRealIP(req);
  const userAgent = req.get("User-Agent") || "";
  const data = `${ip}_${userAgent}`;
  return crypto
    .createHash("sha256")
    .update(data)
    .digest("hex")
    .substring(0, 32);
}

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

// Log ALLE registreringsforsøg til database (backward compatible)
async function logRegistrationAttempt(
  req,
  kommune,
  antal,
  isValid,
  validationErrors = [],
  rateLimitHit = false
) {
  try {
    // Tjek hvilke kolonner der findes
    const columnCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'registrations' 
      AND column_name IN ('is_valid', 'validation_errors', 'request_headers', 'rate_limit_hit')
    `);

    const availableColumns = columnCheck.rows.map((row) => row.column_name);
    const hasNewColumns = availableColumns.length > 0;

    if (hasNewColumns) {
      // Brug nye kolonner
      const result = await pool.query(
        `
        INSERT INTO registrations (
          kommune, antal, is_valid, validation_errors,
          ip_address, user_agent, fingerprint, request_headers,
          rate_limit_hit
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, created_at
      `,
        [
          kommune,
          antal,
          isValid,
          validationErrors,
          getRealIP(req),
          req.get("User-Agent"),
          generateFingerprint(req),
          JSON.stringify({
            "x-forwarded-for": req.headers["x-forwarded-for"],
            "x-real-ip": req.headers["x-real-ip"],
            "user-agent": req.headers["user-agent"],
            referer: req.headers["referer"],
          }),
          rateLimitHit,
        ]
      );

      return result.rows[0];
    } else {
      // Fallback til gamle kolonner (kun gyldige registreringer)
      if (isValid) {
        const result = await pool.query(
          `
          INSERT INTO registrations (kommune, antal, ip, fingerprint)
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `,
          [kommune, antal, getRealIP(req), generateFingerprint(req)]
        );

        return result.rows[0];
      }
      return null;
    }
  } catch (error) {
    console.error("Fejl ved logging af registreringsforsøg:", error);
    return null;
  }
}

function validateRegistration(kommune, antal) {
  const errors = [];

  if (!kommune) {
    errors.push("Kommune er påkrævet");
  } else if (!isValidKommune(kommune)) {
    errors.push("Ugyldig kommune");
  }

  if (!antal) {
    errors.push("Antal er påkrævet");
  } else if (!Number.isInteger(antal) || antal < 1 || antal > 50) {
    errors.push("Antal skal være mellem 1-50");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// API Routes

// GET /api/stats - Backward compatible
app.get("/api/stats", async (req, res) => {
  try {
    // Tjek om is_valid kolonne eksisterer
    const hasValidColumn = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'registrations' 
        AND column_name = 'is_valid'
      )
    `);

    const validFilter = hasValidColumn.rows[0].exists
      ? "AND is_valid = true"
      : "";
    const dateFilter = hasValidColumn.rows[0].exists
      ? "date_key = CURRENT_DATE"
      : "DATE(created_at) = CURRENT_DATE";

    // Dagens statistikker
    const todayStats = await pool.query(`
      SELECT 
        COUNT(*) as count,
        SUM(antal) as total_visitors
      FROM registrations 
      WHERE ${dateFilter} ${validFilter}
    `);

    // Total statistikker
    const totalStats = await pool.query(`
      SELECT 
        COUNT(*) as count,
        SUM(antal) as total_visitors,
        COUNT(DISTINCT ${
          hasValidColumn.rows[0].exists ? "date_key" : "DATE(created_at)"
        }) as total_days
      FROM registrations 
      WHERE TRUE ${validFilter}
    `);

    // Kommune statistikker for i dag
    const kommuneStats = await pool.query(`
      SELECT kommune, SUM(antal) as count
      FROM registrations 
      WHERE ${dateFilter} ${validFilter}
      GROUP BY kommune
      ORDER BY count DESC
    `);

    // Seneste registrering
    const lastRegistration = await pool.query(`
      SELECT created_at
      FROM registrations 
      WHERE TRUE ${validFilter}
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const todayTotal = parseInt(todayStats.rows[0]?.total_visitors) || 0;
    const totalVisitors = parseInt(totalStats.rows[0]?.total_visitors) || 0;
    const totalDays = parseInt(totalStats.rows[0]?.total_days) || 1;
    const avgDaily = Math.round(totalVisitors / totalDays);

    const kommuneStatsObj = {};
    kommuneStats.rows.forEach((row) => {
      kommuneStatsObj[row.kommune] = parseInt(row.count);
    });

    const topKommune = kommuneStats.rows[0]?.kommune || "Ingen data";

    const lastReg = lastRegistration.rows[0];
    const lastRegistrationTime = lastReg
      ? new Date(lastReg.created_at).toLocaleTimeString("da-DK", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Ingen endnu";

    res.json({
      todayTotal,
      totalVisitors,
      totalDays,
      avgDaily,
      topKommune,
      lastRegistration: lastRegistrationTime,
      kommuneStats: kommuneStatsObj,
      lastUpdate: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Fejl ved hentning af statistikker:", error);
    res.status(500).json({ error: "Intern serverfejl" });
  }
});

// POST /api/register - Med fuld logging
app.post("/api/register", registrationLimiter, async (req, res) => {
  const { kommune, antal } = req.body;
  const fingerprint = generateFingerprint(req);

  try {
    const validation = validateRegistration(kommune, antal);

    if (!validation.isValid) {
      await logRegistrationAttempt(
        req,
        kommune,
        antal,
        false,
        validation.errors
      );

      return res.status(400).json({
        error: validation.errors[0],
        logged: true,
      });
    }

    // Check for duplikater - backward compatible
    const duplicateQuery = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'registrations' 
      AND column_name IN ('date_key', 'is_valid')
    `);

    const hasDateKey = duplicateQuery.rows.some(
      (row) => row.column_name === "date_key"
    );
    const hasValidColumn = duplicateQuery.rows.some(
      (row) => row.column_name === "is_valid"
    );

    const dateCondition = hasDateKey
      ? "date_key = CURRENT_DATE"
      : "DATE(created_at) = CURRENT_DATE";
    const validCondition = hasValidColumn ? "AND is_valid = true" : "";

    const existingToday = await pool.query(
      `
      SELECT id, kommune, antal 
      FROM registrations 
      WHERE fingerprint = $1 AND ${dateCondition} ${validCondition}
    `,
      [fingerprint]
    );

    if (existingToday.rows.length > 0) {
      await logRegistrationAttempt(req, kommune, antal, false, [
        "Allerede registreret i dag",
      ]);

      return res.status(409).json({
        error: "Du har allerede registreret dig i dag",
        alreadyRegistered: true,
        logged: true,
      });
    }

    const logResult = await logRegistrationAttempt(
      req,
      kommune,
      antal,
      true,
      []
    );

    // Beregn dagens besøgsnummer
    const todayCount = await pool.query(`
      SELECT SUM(antal) as total
      FROM registrations 
      WHERE ${dateCondition} ${validCondition}
    `);

    const todayTotal = parseInt(todayCount.rows[0]?.total) || antal;

    console.log(
      `✅ Ny gyldig registrering: ${kommune}, ${antal} personer (Total i dag: ${todayTotal})`
    );

    res.status(201).json({
      success: true,
      todayCount: todayTotal,
      message: `Registreret som besøgende #${todayTotal} i dag fra ${kommune}`,
      registrationId: logResult?.id,
    });
  } catch (error) {
    console.error("Fejl ved registrering:", error);
    res.status(500).json({ error: "Intern serverfejl" });
  }
});

// Resten af API routes... (admin login, export, etc.)
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || "admin";
  const ADMIN_PASS = process.env.ADMIN_PASS || "nordjylland2025";

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    res.json({ success: true, token: "admin_session_" + Date.now() });
  } else {
    res.status(401).json({ error: "Forkert brugernavn eller adgangskode" });
  }
});

// Frontend routes
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

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint ikke fundet" });
});

// Start server med auto-migration
async function startServer() {
  try {
    await pool.query("SELECT NOW()");
    console.log("✅ Database forbindelse etableret");

    // Auto-migrate database structure
    await ensureTableStructure();

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

process.on("SIGTERM", async () => {
  console.log("Server lukker ned...");
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Server lukker ned...");
  await pool.end();
  process.exit(0);
});

startServer();

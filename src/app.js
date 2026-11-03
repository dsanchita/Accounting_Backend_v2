import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import passport from "passport";
import { initializeDatabaseConnections, getConnectedModules } from "./config/databases.js";
import errorHandler from "./utils/errorHandler.js";
import { initializeEntities } from "./utils/initializeEntities.js";

// Routes
import authRoutes from "./modules/auth/routes.js";
import userRoutes from "./modules/user/routers/routes.js";
import companyRoutes from "./modules/company/routers/routes.js";
import masterDataRoutes from "./modules/masterData/routers/masterDataRoutes.js";
import accountingRoutes from "./modules/Account/routers/accountingAggregator.js";
import invoiceRoutes from "./modules/Invoice/routers/invoiceAggregator.js";
import invoiceAccountingRoutes from "./modules/Invoice/routers/invoiceAccountingRoutes.js";
import auditRoutes from "./modules/audit/routes.js";
import systemRoutes from "./routes/systemRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import hrmsIntegrationRoutes from "./modules/Account/routers/hrmsIntegrationRoutes.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// Middleware
app.use(express.json({
  limit: "10mb",
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: true }));

// 🔧 Dynamic CORS Configuration for Development & Production
const allowedOrigins = [
  // Development
  "http://localhost:5173",
  "http://localhost:3000",
  // Production - from environment variable
  process.env.CLIENT_URL,
  // Additional allowed origins from environment
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : []),
].filter(Boolean); // Remove null/undefined values

console.log("🔐 CORS Allowed Origins:", allowedOrigins.join(", "));

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests without origin (like mobile apps or curl requests)
      if (!origin) {
        return callback(null, true);
      }

      // Check if origin is in allowed list
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`⚠️  CORS blocked request from origin: ${origin}`);
        console.log(`   Allowed origins: ${allowedOrigins.join(", ")}`);
        callback(new Error("CORS: Origin not allowed"));
      }
    },
    credentials: true, // ✅ Allow credentials (cookies, Authorization headers)
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    maxAge: 86400, // 24 hours
  })
);

app.use(cookieParser());
app.use(passport.initialize());

// Initialize all database connections
export const initializeDatabases = async () => {
  try {
    // ✅ Validate AVAILABLE_MODULES before initializing
    const modulesEnv = process.env.AVAILABLE_MODULES;
    if (!modulesEnv) {
      throw new Error("❌ AVAILABLE_MODULES is not defined in environment variables!");
    }

    // ✅ Validate JSON format
    try {
      JSON.parse(modulesEnv);
    } catch (parseError) {
      throw new Error(`❌ Invalid JSON in AVAILABLE_MODULES: ${parseError.message}\nValue: ${modulesEnv}`);
    }

    // Initialize all databases from AVAILABLE_MODULES
    await initializeDatabaseConnections();

    // Initialize default entities after all databases are connected
    await initializeEntities();
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }
};

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "✅ Server and databases are connected" });
});

// System Info Routes (PUBLIC - No authentication required)
app.use("/api/system", systemRoutes);

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/masterData", masterDataRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/integrations/hrms", hrmsIntegrationRoutes);

/**
 * Register module-specific routes based on connected databases
 * This is called AFTER databases are initialized
 */
export const registerModuleRoutes = () => {
  try {
    // ✅ Now this is safe - databases are already initialized when this is called
    const connectedModules = getConnectedModules();
    console.log('====================================');
    console.log('Connected Modules:', connectedModules);
    console.log('====================================');

    if (connectedModules.includes("accounting")) {
      console.log("✅ Accounting module routes registered at /api/accounting");
      app.use("/api/accounting", accountingRoutes);
    }

    if (connectedModules.includes("invoice")) {
      console.log("✅ Invoice module routes registered at /api/invoice");
      app.use("/api/invoices", invoiceRoutes);
      console.log("✅ Invoice accounting routes registered at /api/invoice-accounting");
      app.use("/api/invoice-accounting", invoiceAccountingRoutes);
    }
  } catch (error) {
    console.error("⚠️  Failed to register module routes:", error.message);
  }
};

/**
 * Register error handlers (must be called AFTER all routes are registered)
 * This is called in server.js after registerModuleRoutes()
 */
export const registerErrorHandlers = () => {
  // 404 Handler - catches routes that don't exist
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: "Route not found",
    });
  });

  // Error Handler (must be last)
  app.use(errorHandler);
};

export default app;
 

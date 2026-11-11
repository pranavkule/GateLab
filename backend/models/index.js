const mongoose = require('mongoose');

// A routing configuration version. The active config is the doc with the
// highest version. Gateways cache it in memory and replace it atomically.
const RouteConfigSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true, index: true },
    routes: [
      {
        _id: false,
        id: { type: String, required: true },
        path: { type: String, required: true },        // e.g. /api/users/*
        targetService: { type: String, required: true }, // users | products | orders
        authRequired: { type: Boolean, default: true },
        enabled: { type: Boolean, default: true },
      },
    ],
    appliedAt: { type: Date, default: Date.now },
    appliedBy: { type: String, default: 'admin' },
  },
  { timestamps: true }
);

// Audit trail of every configuration change.
const ConfigAuditSchema = new mongoose.Schema(
  {
    version: Number,
    action: { type: String, enum: ['create', 'update', 'seed'] },
    changedBy: { type: String, default: 'admin' },
    summary: String,
    routes: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  }
);

// Persisted request log (written asynchronously in batches by the control plane).
const RequestLogSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    method: String,
    path: String,
    gateway: String,        // e.g. gateway-3001 | entry-lb
    backendService: String, // users | products | orders | none
    backendInstance: String,// e.g. 4001 | none
    jwtStatus: { type: String, enum: ['valid', 'missing', 'invalid', 'expired', 'none'] },
    status: Number,
    latencyMs: Number,
    error: String,
  }
);
RequestLogSchema.index({ timestamp: -1 });

// Demo users for the login flow.
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String, // demo only - plain text on purpose for a teaching lab
  role: { type: String, default: 'student' },
});

const RouteConfig = mongoose.models.RouteConfig || mongoose.model('RouteConfig', RouteConfigSchema);
const ConfigAudit = mongoose.models.ConfigAudit || mongoose.model('ConfigAudit', ConfigAuditSchema);
const RequestLog = mongoose.models.RequestLog || mongoose.model('RequestLog', RequestLogSchema);
const User = mongoose.models.User || mongoose.model('User', UserSchema);

module.exports = { RouteConfig, ConfigAudit, RequestLog, User };

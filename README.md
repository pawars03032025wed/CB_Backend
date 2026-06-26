# ⚙️ CareBridge+ Backend Application & API Service

Welcome to the **CareBridge+** backend application. This is a Node.js and Express API server written in TypeScript. It handles role authentication, clinic referrals, messaging networks, and coordinates AI microservices using the Google Gemini API.

---

## 🛠️ Tech Stack & Database Architecture

*   **Node.js & Express**: Provides a lightweight, high-performance API routing layer, complete with request logging and client-side IP-based rate limiting.
*   **SQLite & `better-sqlite3`**: Powers local database operations. It includes automatic schema checks, table migrations, and query indexes.
*   **Google Gemini AI SDK (`@google/genai`)**: Drives advanced features like Text-to-Speech (TTS), diagnostic suggestions, and natural language clinical advising.
*   **jsPDF**: Programmatically designs and compiles vector-based audit reports inside the backend.
*   **Esbuild**: Bundles the TypeScript server code into a production CJS module.

---

## 📂 Codebase Directory Structure

The backend application code lives under the `backend/` directory, structured as follows:

```bash
backend/
├── carebridge.db           # SQLite database file containing structured relational tables
├── generate_pdf.ts         # Programmatic PDF report compiler using jsPDF
├── server.ts               # Core Express server, API routes, rate-limiting, and Vite dev integration
└── README.md               # Backend Developer Guide (this file)
```

---

## 🔌 API Route Map

The server provides a clean REST API interface prefixing `/api`:

### 📋 Administrative & Entities
*   `PATCH /api/users/:id/status` — Approve or suspend a clinic or hospital account.
*   `PATCH /api/hospital_details/:user_id/tier` — Update hospital pricing or certification tier.
*   `PATCH /api/clinic_details/:user_id/tier` — Update clinic status level.
*   `PATCH /api/clinic_details/:user_id/rating` — Update rating attributes.

### 🔄 Patient Referrals & Messages
*   `PATCH /api/referrals/:id/status` — Triage referral status (`pending`, `accepted`, `scheduled`, `discharged`).
*   `GET /api/messages` — Fetch role-based message inbox.
*   `GET /api/users/:id` — Retrieve user profile parameters.

### 🤖 Google Gemini AI Microservices
*   `POST /api/ai/chat` — Patient Health Coach. Utilizes a **10-minute Server-Side Response Cache** to speed up repeated queries and conserve API quota.
*   `POST /api/ai/marketing` — Clinic Copywriter. Generates multilingual (English/Hindi/Marathi) poster copy, WhatsApp briefs, or growth advice.
*   `POST /api/ai/diagnosis` — Generates tentative clinical advice warnings from patient vitals and symptoms.
*   `POST /api/ai/prescription-suggestions` — Suggests dosage frequencies and follow-up lab tests.
*   `POST /api/ai/tts` — Text-to-Speech engine. Compiles message strings into **base64-encoded audio streams** utilizing the `gemini-3.1-flash-tts-preview` voice model.

---

## 💾 Database Schema & Default Seeding

On startup, the SQLite database is automatically created as `backend/carebridge.db`. It defines indices and seeds default testing users:

*   **Admin Access**:
    *   **Username**: `PLUSADMIN`
    *   **Password**: `plus@098`
*   **Hospital Portals**: `PLUSHOSPITAL`, `CITYHOSP`, `APEXHOSP`, `SUNRISEHOSP`
*   **Clinic Portals**: `PLUSCLINIC`, `AURANGABADCLINIC`, `PUNECLINIC`

---

## 📈 Firestore Consumption PDF Audit

The script `generate_pdf.ts` compiles a professional compliance PDF report explaining billing parameters, active readers, and Firebase Firestore scan optimizations.

To run the generator manually:
```bash
npx tsx backend/generate_pdf.ts
```
*This places the generated report at `frontend/public/firebase_consumption_report.pdf` which can be downloaded directly from the patient/admin UI.*

---

## 🚀 Runtime & Configuration Commands

Ensure you have a `.env` file configured at the project root containing:
```env
GEMINI_API_KEY=AIzaSy...   # Your Google AI studio developer key
VITE_PROD=false            # Set to true for compiled client static serving
```

*   **Start Combined Dev Environment**:
    ```bash
    npm run dev
    ```
    *Executes `tsx backend/server.ts`. The server boots up and loads the Vite development server in middleware mode.*
*   **Build stand-alone Node module**:
    ```bash
    npm run build
    ```
    *Bundles the server logic into `dist/server.cjs` and the client into `dist/`.*
*   **Start Production Server**:
    ```bash
    npm run start
    ```
    *Launches node directly against the compiled `dist/server.cjs` file.*

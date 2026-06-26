import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import Database from "better-sqlite3";
import path from "path";
import fsPromises from "fs/promises";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { GoogleGenAI, Modality } from "@google/genai";

const logFile = path.resolve(process.cwd(), "server.log");
const log = (msg: string) => {
  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const formattedMsg = `[${timestamp}] ${msg}`;
  console.log(formattedMsg);
  try {
    fs.appendFileSync(logFile, formattedMsg + "\n");
  } catch (err) {
    // Ignore logging errors
  }
};

// Robust Production Detection
const getIsProd = () => {
  return process.env.NODE_ENV === "production" || 
         process.env.VITE_PROD === "true";
};

log("[Server] Starting server.ts...");

process.on('uncaughtException', (err) => {
  log(`[Server] Uncaught Exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`[Server] Unhandled Rejection at: ${promise} reason: ${reason}`);
});

const _filename = typeof import.meta !== "undefined" && import.meta.url ? fileURLToPath(import.meta.url) : (typeof __filename !== "undefined" ? __filename : "");
const _dirname = _filename ? path.dirname(_filename) : (typeof __dirname !== "undefined" ? __dirname : process.cwd());

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  const PORT = 3000;

  // Health checks at the VERY top
  app.get("/health", (req, res) => {
    const isProd = getIsProd();
    const distPath = path.join(process.cwd(), "dist");
    const indexPath = path.join(distPath, "index.html");
    const assetsPath = path.join(distPath, "assets");
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      isProd,
      distExists: fs.existsSync(distPath),
      indexExists: fs.existsSync(indexPath),
      assetsExists: fs.existsSync(assetsPath),
      env: process.env.NODE_ENV,
      viteProd: process.env.VITE_PROD
    });
  });

  app.get("/hello", (req, res) => {
    res.send("Hello from CareBridge!");
  });

  app.get("/ping", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/health", (req, res) => {
    const isProd = getIsProd();
    const distPath = path.join(process.cwd(), "dist");
    const distExists = fs.existsSync(distPath);
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      env: process.env.NODE_ENV,
      viteProd: process.env.VITE_PROD,
      isProd,
      distExists,
      db: !!db
    });
  });

  // Request logging middleware - MOVE TO TOP
  app.use((req, res, next) => {
    const isProd = getIsProd();
    const isSourceFile = req.url.match(/\.(ts|tsx|js|mjs|css|json|png|jpg|svg|ico)$/) || req.url.includes('/node_modules/') || req.url.includes('@vite');
    
    if (!req.url.startsWith('/assets') && (isProd || !isSourceFile)) {
      log(`[Request] ${req.method} ${req.url} (Mode: ${isProd ? 'Prod' : 'Dev'})`);
    }
    next();
  });

  app.use(express.json());

  // In-memory rate limiter for server performance and protection against API quota depletion
  const aiRateLimits = new Map<string, { count: number; resetTime: number }>();
  const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
  const MAX_AI_REQUESTS = 25; // Max 25 requests/min per IP

  const aiRateLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = (req.headers["x-forwarded-for"] as string || "").split(",")[0].trim() || 
               req.socket.remoteAddress || 
               "unknown-client";
    const now = Date.now();
    const limitInfo = aiRateLimits.get(ip);

    if (!limitInfo || now > limitInfo.resetTime) {
      aiRateLimits.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
      next();
    } else if (limitInfo.count >= MAX_AI_REQUESTS) {
      log(`[RateLimit] Throttle block triggered from IP: ${ip} on route ${req.url}`);
      res.status(429).json({ error: "Too many requests. Please throttle your requests or try again shortly." });
    } else {
      limitInfo.count += 1;
      next();
    }
  };

  app.use("/api/ai/*", aiRateLimiter);

  // Gemini AI Setup
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log("[Server] WARNING: GEMINI_API_KEY is not set in environment.");
  }

  const ai = new GoogleGenAI({
    apiKey: (apiKey || "dummy_key") as string,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  const MODEL_NAME = "gemini-3.5-flash";
  const FALLBACK_MODEL_NAME = "gemini-3.1-flash-lite";

  // Clean raw or stringified JSON API errors into standard readable status messages 
  function cleanErrorMessage(error: any): string {
    if (!error) return "Unknown error";
    const msg = typeof error === "string" ? error : (error.message || "");
    if (msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("limit") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429")) {
      return "Quota Exceeded (429)";
    }
    if (msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand")) {
      return "Temporarily Unavailable (503)";
    }
    return msg;
  }

  // Dynamic retry generator with backoff and fallback model
  async function generateGeminiContentWithRetry(params: {
    contents: any;
    config?: any;
    defaultModel?: string;
    fallbackModel?: string;
  }) {
    const modelToUse = params.defaultModel || MODEL_NAME;
    const maxRetries = 2;
    let delay = 300; // ms

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelToUse,
          contents: params.contents,
          config: params.config,
        });
        return response;
      } catch (error: any) {
        const isUnavailable = error?.message?.includes("503") || 
                              error?.message?.includes("UNAVAILABLE") || 
                              error?.message?.includes("high demand") ||
                              (error?.status === 503) ||
                              (error?.code === 503);
        const isQuota = error?.message?.includes("429") || 
                        error?.message?.includes("quota") || 
                        error?.message?.includes("limit") ||
                        error?.message?.includes("RESOURCE_EXHAUSTED") ||
                        (error?.status === 429) ||
                        (error?.code === 429);

        if (isUnavailable && attempt < maxRetries) {
          log(`[Gemini Retry] Attempt ${attempt} failed on ${modelToUse} due to load. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2.5; // exponential multiplier
        } else if ((isUnavailable || isQuota) && params.fallbackModel) {
          log(`[Gemini Fallback] Attempting fallback model: ${params.fallbackModel} due to ${isQuota ? 'quota limit' : 'high load'}`);
          try {
            const fbResponse = await ai.models.generateContent({
              model: params.fallbackModel,
              contents: params.contents,
              config: params.config,
            });
            return fbResponse;
          } catch (fallbackError: any) {
            const cleanFbMsg = cleanErrorMessage(fallbackError);
            log(`[Gemini Fallback Error] Fallback model failed: ${cleanFbMsg}`);
            throw new Error(cleanFbMsg);
          }
        } else {
          const cleanMsg = cleanErrorMessage(error);
          throw new Error(cleanMsg);
        }
      }
    }
    throw new Error("API content generation failed after retry attempts");
  }

  // Backup dictionary generator for a seamless smart health fallback when Gemini is fully offline
  function getBackupPrescription(complaints: string[], vitals: any) {
    const compStr = (complaints || []).join(", ").toLowerCase();
    
    let suggestedDiagnosis = ["Acute Viral Illness", "Symptomatic Care Needed"];
    let suggestedAdvice = [
      "Ensure adequate hydration and dynamic bed rest.",
      "Monitor body temperature and blood pressure twice daily.",
      "Avoid heavy or oily food; prefer light, warm meals."
    ];
    let suggestedMedicines = [
      {
        name: "Paracetamol 650mg",
        dose: "1 Tablet",
        frequency: "1-0-1 (Twice Daily) or SOS for fever",
        duration: "3 Days",
        timing: "After Food",
        route: "Oral",
        quantity: "6"
      },
      {
        name: "Multivitamin Active Capsules",
        dose: "1 Capsule",
        frequency: "0-0-1 (Once Daily)",
        duration: "5 Days",
        timing: "After Food",
        route: "Oral",
        quantity: "5"
      }
    ];
    let suggestedInvestigations = ["Complete Blood Count (CBC)", "Routine Consultation Review"];

    if (compStr.includes("fever") || compStr.includes("pyrexia") || compStr.includes("temperature")) {
      suggestedDiagnosis = ["Mild Viral Fever", "Symptomatic Pyrexia"];
      suggestedAdvice = [
        "Keep body cool by dynamic sponge baths if temperature exceeds 101°F.",
        "Stay well hydrated with plenty of water, juice, and clear soups.",
        "Avoid heavy physical exertion until fever resides for 24 hours."
      ];
    } else if (compStr.includes("cough") || compStr.includes("cold") || compStr.includes("throat")) {
      suggestedDiagnosis = ["Upper Respiratory Tract Infection (URTI)", "Acute Pharyngitis"];
      suggestedAdvice = [
        "Perform warm saline gargles 3-4 times a day.",
        "Steam inhalation twice daily is highly recommended.",
        "Avoid cold beverages, ice creams, and exposure to chilly weather."
      ];
      suggestedMedicines = [
        {
          name: "Levo-Cetirizine 5mg",
          dose: "1 Tablet",
          frequency: "0-0-1 (At Bedtime)",
          duration: "5 Days",
          timing: "After Food",
          route: "Oral",
          quantity: "5"
        },
        {
          name: "Cough Syrup (Ascoril-D or Equivalent)",
          dose: "10 ml",
          frequency: "1-1-1 (Thrice Daily)",
          duration: "4 Days",
          timing: "Before/After Food",
          route: "Oral",
          quantity: "1 Bottle"
        }
      ];
    } else if (compStr.includes("stomach") || compStr.includes("pain") || compStr.includes("motion") || compStr.includes("diarrhoea") || compStr.includes("vomit")) {
      suggestedDiagnosis = ["Mild Gastroenteritis", "Dyspepsia / Acid Reflux"];
      suggestedAdvice = [
        "Sip Oral Rehydration Salt (ORS) solutions continuously to restore fluids.",
        "Eat a strict light diet (rice gruel, curd rice, bananas).",
        "Avoid tea, coffee, hot spices, and raw milk products."
      ];
      suggestedMedicines = [
        {
          name: "Pantoprazole 40mg",
          dose: "1 Tablet",
          frequency: "1-0-0 (Once Daily)",
          duration: "5 Days",
          timing: "Before Food",
          route: "Oral",
          quantity: "5"
        },
        {
          name: "ORS (Oral Rehydration Salts) sachet",
          dose: "1 Sachet in 1L water",
          frequency: "Drink SOS throughout the day",
          duration: "3 Days",
          timing: "Before/After Food",
          route: "Oral",
          quantity: "3"
        }
      ];
    } else if (compStr.includes("headache") || compStr.includes("migraine")) {
      suggestedDiagnosis = ["Tension Type Headache", "Symptomatic Head Pain"];
      suggestedAdvice = [
        "Rest in a quiet, dark and well-ventilated room.",
        "Minimize screen exposure (mobiles, laptops, TV) immediately.",
        "Maintain a consistent sleep cycle and avoid skipping meals."
      ];
    }

    // Add notice that backup database suggestion was used safely
    suggestedAdvice.push("Clinic Backup Activated (clinical AI assistant represents backup recommendations).");

    return {
      suggestedDiagnosis,
      suggestedAdvice,
      suggestedMedicines,
      suggestedInvestigations
    };
  }

  // Server-side response caching for AI health coach chat.
  // Saves latencies and avoids redundant remote API calls.
  const aiChatResponseCache = new Map<string, { responseText: string; timestamp: number }>();
  const CHAT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache TTL

  function deduplicateParagraphs(text: string): string {
    if (!text) return text;
    const lines = text.split("\n");
    const seen = new Set<string>();
    const uniqueLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seen.has(normalized)) {
        return null; // Ignore repeated paragraph
      }
      seen.add(normalized);
      return line;
    }).filter(line => line !== null);
    return uniqueLines.join("\n");
  }

  // Server-side Clinic Marketing AI and Content Generator
  app.post("/api/ai/marketing", async (req, res) => {
    try {
      log(`[AI Marketing] Generation request started: ${req.body?.type}`);
      if (!apiKey) {
        log(`[AI Marketing] Warning: API key missing, serving fallback content`);
      }

      const { type, payload = {} } = req.body || {};
      if (!type) {
        return res.status(400).json({ error: "Marketing type is required" });
      }

      let prompt = "";
      let systemInstruction = "You are an expert healthcare marketer and copywriting engine fluent in English, Hindi, and Marathi. You design professional, patient-centric communications with correct clinical terminology.";

      if (type === "poster") {
        prompt = `Generate a high-converting, professional healthcare poster layout and copywriting in JSON for:
          Topic: ${payload.topic || "Health Awareness"}
          Clinic Name: ${payload.clinicName || "Carebridge Plus Clinic"}
          Doctor Name: ${payload.doctorName || "Dr. Pawar"}
          Speciality: ${payload.speciality || "General Physician"}
          Contact: ${payload.contactName || "9988776655"}
          Address: ${payload.address || "Main Clinic Road"}
          Website: ${payload.website || "www.carebridgeplus.com"}
          Category: ${payload.category || "General Health"}

          Provide high-quality clinical copywriting in three languages (english, hindi, marathi).
          Return clean JSON with these exact fields:
          {
            "headline": {
              "english": "Short, catchy headline (max 5 words)",
              "hindi": "Hindi translation of headline (professional and highly standard medical vocabulary)",
              "marathi": "Marathi translation of headline (professional and highly standard medical vocabulary)"
            },
            "tagline": {
              "english": "Inspiring medical tagline (max 10 words)",
              "hindi": "Hindi translation of tagline",
              "marathi": "Marathi translation of tagline"
            },
            "content": {
              "english": "Compelling patient educational brief or awareness warnings (max 40 words)",
              "hindi": "Hindi translation of content (max 40 words)",
              "marathi": "Marathi translation of content (max 40 words)"
            },
            "cta": {
              "english": "Strong medical action call (max 5 words)",
              "hindi": "Hindi translation of CTA",
              "marathi": "Marathi translation of CTA"
            },
            "accent": "A beautiful CSS gradient background (e.g. 'from-teal-600 to-cyan-800' or 'from-indigo-900 to-[#0e7490]' or 'from-slate-900 to-[#1e293b]')"
          }`;
      } else if (type === "image") {
        prompt = `Generate a creative photo prompt and detail specification for a medical/wellness marketing image for:
          Category: ${payload.category || "General Practice"}
          Visual Type: ${payload.visualType || "Social Media Graphic"}
          Theme/Description: ${payload.theme || "Routine Healthy Checkup"}

          Provide high-quality titles and description layout text in three languages (english, hindi, marathi).
          Return clean JSON with these exact fields:
          {
            "prompt": "Detailed photorealistic description in English to feed into an image generative AI system (max 60 words, clean medical/wellness setting)",
            "title": {
              "english": "Short english title describing the graphic",
              "hindi": "Hindi title",
              "marathi": "Marathi title"
            },
            "suggestedLayout": {
              "english": "Visual placement tips (e.g., Doctors on right, clean typography on left)",
              "hindi": "Hindi translation or tip",
              "marathi": "Marathi translation or tip"
            },
            "description": {
              "english": "Short description of the patient education message (max 20 words)",
              "hindi": "Hindi translation (max 20 words)",
              "marathi": "Marathi translation (max 20 words)"
            }
          }`;
      } else if (type === "whatsapp") {
        prompt = `Generate three variations of professional WhatsApp messages (Short, Medium, Detailed) for:
          Category: ${payload.category || "Health Tips"}
          Clinic Name: ${payload.clinicName || "Carebridge Plus Clinic"}
          Topic Details: ${payload.details || "Importance of hydration"}
          Contact: ${payload.contact || "9988776655"}

          Make sure it uses professional emojis naturally and keeps appropriate placeholders.
          Provide each variation in three languages (english, hindi, marathi).
          Return clean JSON with these exact fields:
          {
            "short": {
              "english": "Short message in English (max 50 words including emojis)",
              "hindi": "Short message in Hindi",
              "marathi": "Short message in Marathi"
            },
            "medium": {
              "english": "Medium message in English with headers and bullets (max 100 words)",
              "hindi": "Medium message in Hindi",
              "marathi": "Medium message in Marathi"
            },
            "detailed": {
              "english": "Detailed educational message in English with CTA and details (max 180 words)",
              "hindi": "Detailed message in Hindi",
              "marathi": "Detailed message in Marathi"
            }
          }`;
      } else if (type === "campaign") {
        prompt = `Generate a complete multi-channel healthcare awareness campaign package in JSON for:
          Campaign Name/Topic: ${payload.topic || "Monsoon Immune Shield"}
          Target Audience: ${payload.target || "All Patients"}
          Clinic Name: ${payload.clinicName || "Carebridge Plus Clinic"}

          Provide all textual components in three languages (english, hindi, marathi).
          Return clean JSON with these exact fields:
          {
            "posterHeadline": {
              "english": "Poster title (max 5 words)",
              "hindi": "Hindi poster title",
              "marathi": "Marathi poster title"
            },
            "posterContent": {
              "english": "Poster brief info (max 35 words)",
              "hindi": "Hindi brief info",
              "marathi": "Marathi brief info"
            },
            "posterCta": {
              "english": "Action call (max 5 words)",
              "hindi": "Hindi action call",
              "marathi": "Marathi action call"
            },
            "imagePrompt": "Clinical image design concept prompt",
            "whatsappMessage": {
              "english": "Outreach message with bullet points (max 120 words)",
              "hindi": "Hindi outreach message",
              "marathi": "Marathi outreach message"
            },
            "socialCaption": {
              "english": "Engaging caption with hashtags in English",
              "hindi": "Hindi caption with hashtags",
              "marathi": "Marathi caption with hashtags"
            },
            "suggestedSchedule": {
              "english": "Suggested launch timeline plan (e.g. Day 1: Broadcast, Day 3: Poster)",
              "hindi": "Hindi timeline",
              "marathi": "Marathi timeline"
            }
          }`;
      } else if (type === "content") {
        prompt = `Generate professional healthcare social media content variations in three languages (English, Marathi, Hindi) for:
          Format: ${payload.format || "Social Media Post"}
          Clinic Name: ${payload.clinicName || "Carebridge Plus"}
          Subject Topic: ${payload.subject || "Benefits of early disease screenings"}

          Return clean JSON with these exact fields:
          {
            "english": "Engaging, polite copy in English with medical credibility",
            "marathi": "Professional translated copywriting in Marathi",
            "hindi": "Professional translated copywriting in Hindi"
          }`;
      } else if (type === "advisor") {
        prompt = `You are "Carebridge Marketing Director AI". Act as a highly professional growth and marketing advisor for:
          Clinic Specialty: ${payload.speciality || "Family Medicine"}
          Clinic City: ${payload.city || "Aurangabad"}
          Doctor/Staff info: ${payload.doctorName || "Dr. Patil"}

          Provide exactly 4 highly actionable, custom local growth strategies/campaign ideas for this specific clinic.
          Return clean JSON as an array of objects:
          [
            {
              "title": "Creative campaign title",
              "description": "Clear explanation of the campaign",
              "effort": "Low" or "Medium" or "High",
              "impact": "High" or "Medium",
              "actionPlan": "Three step bullet points to execute this easily"
            }
          ]`;
      }

      // Execute AI generation
      if (apiKey) {
        const response = await generateGeminiContentWithRetry({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.6,
          },
          fallbackModel: FALLBACK_MODEL_NAME
        });

        const text = response.text || "{}";
        const resJson = JSON.parse(text);
        return res.json(resJson);
      } else {
        throw new Error("No API Key");
      }
    } catch (error: any) {
      log(`[AI Marketing Fallback] API error: ${error.message}. Serving clean local presets.`);
      
      // Standalone clinical default fallback logic
      const type = req.body?.type;
      const payload = req.body?.payload || {};

      if (type === "poster") {
        return res.json({
          headline: {
            english: `SECURE YOUR ${payload.topic?.toUpperCase() || "HEALTH"}`,
            hindi: `अपने ${payload.topic || "स्वास्थ्य"} को सुरक्षित करें`,
            marathi: `तुमचे ${payload.topic || "आरोग्य"} सुरक्षित करा`
          },
          tagline: {
            english: "Healthy habits lead to a resilient lifestyle",
            hindi: "स्वस्थ आदतें एक मजबूत जीवनशैली की ओर ले जाती हैं",
            marathi: "आरोग्यदायी सवयी चांगल्या जीवनशैलीकडे नेतात"
          },
          content: {
            english: `Our clinical team is fully equipped to handle and consult on early interventions for ${payload.topic || "healthy living"}. Book a screening with us to understand your parameters clearly.`,
            hindi: `हमारी चिकित्सा टीम ${payload.topic || "स्वस्थ जीवन शैली"} के लिए शुरुआती जांच और परामर्श के लिए पूरी तरह सुसज्जित है। अपनी रिपोर्ट समझने के लिए अपॉइंटमेंट बुक करें।`,
            marathi: `आमची वैद्यकीय टीम आपल्या ${payload.topic || "आरोग्यदायी जीवनशैली"} विषयी प्राथमिक तपासणी आणि मार्गदर्शनासाठी सज्ज आहे. आजच आपली वेळ निश्चित करा.`
          },
          cta: {
            english: "Schedule Clinical Health Consultation",
            hindi: "चिकित्सा परामर्श बुक करें",
            marathi: "वैद्यकीय तपासणी बुक करा"
          },
          accent: "from-teal-600 to-indigo-950"
        });
      } else if (type === "image") {
        return res.json({
          prompt: `A beautiful high-contrast photograph of a professional physician consulting a senior patient inside a bright clinic space.`,
          title: {
            english: `${payload.category || "Clinic"} Marketing Graphic`,
            hindi: `${payload.category || "क्लीनिक"} विपणन ग्राफिक`,
            marathi: `${payload.category || "क्लिनिक"} विपणन ग्राफिक`
          },
          suggestedLayout: {
            english: "Centered illustration with light glowing neon green borders.",
            hindi: "चमकदार हल्की हरी सीमाओं के साथ केंद्रित चित्रण।",
            marathi: "चमकदार हिरव्या बॉर्डर्ससह मध्यभागी असलेले चित्र."
          },
          description: {
            english: "Visual emphasizing patient care, stethoscope, and positive outcomes.",
            hindi: "मरीज की देखभाल, स्टेथोस्कोप और सकारात्मक परिणामों पर जोर देने वाला दृश्य।",
            marathi: "रुग्ण काळजी, स्टेथॉस्कोप आणि सकारात्मक परिणामांवर भर देणारे दृश्य."
          }
        });
      } else if (type === "whatsapp") {
        return res.json({
          short: {
            english: `✨ *Health Alert from ${payload.clinicName || "Carebridge clinic"}*: Protect your family against seasonal threats. Text back to book a review. 📞`,
            hindi: `✨ *${payload.clinicName || "केयरब्रिज क्लिनिक"} से स्वास्थ्य अलर्ट*: मौसमी बीमारियों से अपने परिवार को बचाएं। जांच के लिए संपर्क करें। 📞`,
            marathi: `✨ *${payload.clinicName || "केअरब्रिज क्लिनिक"} कडून आरोग्य अलर्ट*: पावसाळी आजारांपासून आपल्या कुटुंबाचे रक्षण करा. तपासणीसाठी आजच संपर्क करा. 📞`
          },
          medium: {
            english: `⭐ *Active Health Insights by ${payload.clinicName || "Carebridge Plus"}* ⭐\n\nDaily small improvements lead to huge fitness results:\n• Stay active with walk loops\n• Keep well hydrated\n• Schedule routine health check-ups\n\nTo consult with our clinical team, respond to this text! 🩺`,
            hindi: `⭐ *${payload.clinicName || "केयरब्रिज प्लस"} द्वारा सक्रिय स्वास्थ्य सुझाव* ⭐\n\nदैनिक छोटे बदलाव बड़ा परिणाम लाते हैं:\n• सक्रिय रहें और टहलें\n• खुद को हाइड्रेटेड रखें\n• नियमित स्वास्थ्य जांच करवाएं\n\nपरामर्श के लिए इस संदेश का उत्तर दें! 🩺`,
            marathi: `⭐ *${payload.clinicName || "केअरब्रिज प्लस"} कडून आरोग्य सल्ला* ⭐\n\nरोजचे छोटे बदल आरोग्यात मोठी सुधारणा घडवू शकतात:\n• दररोज नियमित चालण्याचा व्यायाम करा\n• भरपूर पाणी प्या व हायड्रेटेड रहा\n• नियमित आरोग्य तपासणी करा\n\nअधिक माहिती व वेळेसाठी या मेसेजला उत्तर द्या! 🩺`
          },
          detailed: {
            english: `🌱 *Season Wellness & Immuno-Shield Protocol* 🌱\n\nDear Patients,\n\nAs part of our community mission, ${payload.clinicName || "Carebridge Plus Clinic"} is leading special awareness initiatives this month.\n\nOur specialists urge you to monitor your health parameters closely. Early check-ups help minimize future health complications. \n\n*Why choose Carebridge Plus?*\n1. Personalized therapy layouts\n2. Modern diagnostics ERP integrations\n3. Responsive consultation loops\n\n👉 Respond directly to custom book your slots today!\n📞 ${payload.contact || "9988776655"}`,
            hindi: `🌱 *मौसमी स्वास्थ्य और इम्यूनो-शील्ड प्रोटोकॉल* 🌱\n\nप्रिय मरीज,\n\nहमारे देशव्यापी स्वास्थ्य मिशन के तहत, ${payload.clinicName || "केयरब्रिज प्लस क्लिनिक"} इस महीने विशेष जागरूकता पहल चला रहा है।\n\nहमारे विशेषज्ञ आपसे आग्रह करते हैं कि आप अपनी सेहत पर ध्यान दें। समय पर की गई जांच भविष्य की गंभीर बीमारियों से बचाती है।\n\n*केयरब्रिज प्लस क्यों चुनें?*\n1. व्यक्तिगत उपचार योजना\n2. आधुनिक लैब और जांच सुविधा\n3. त्वरित डॉक्टर परामर्श\n\n👉 आज ही अपना स्लॉट बुक करने के लिए इस संदेश का उत्तर दें!\n📞 ${payload.contact || "9988776655"}`,
            marathi: `🌱 *पावसाळी आरोग्य आणि प्रतिकारशक्ती प्रोटोकॉल* 🌱\n\nप्रिय रुग्ण मित्रहो,\n\nआमच्या आरोग्य मोहिमेचा भाग म्हणून, ${payload.clinicName || "केअरब्रिज प्लस क्लिनिक"} या महिन्यात विशेष आरोग्य जागरूकता उपक्रम राबवत आहे.\n\nआमच्या तज्ञांचे म्हणणे आहे की आपण आपल्या आरोग्याची नियमित काळजी घ्यावी. वेळीच केलेली तपासणी भावी आजारांचा धोका कमी करते.\n\n*केअरब्रिज प्लस का निवडावे?*\n1. वैयक्तिक उपचार आणि औषध योजना\n2. अत्याधुनिक लॅब तपासणी\n3. तत्पर डॉक्टरांचे मार्गदर्शन\n\n👉 आपली भेट निश्चित करण्यासाठी या मेसेजला त्वरित उत्तर द्या किंवा संपर्क साधा!\n📞 ${payload.contact || "9988776655"}`
          }
        });
      } else if (type === "campaign") {
        return res.json({
          posterHeadline: {
            english: `CAMP: ${payload.topic || "Health Guard Active"}`,
            hindi: `शिविर: ${payload.topic || "स्वास्थ्य रक्षक एक्टिव"}`,
            marathi: `शिबीर: ${payload.topic || "आरोग्य कवच अॅक्टिव्ह"}`
          },
          posterContent: {
            english: "Prevent future chronic issues with state-of-the-art assessments from our modern clinical team.",
            hindi: "हमारी आधुनिक चिकित्सा टीम के अत्याधुनिक आकलन के साथ भविष्य की बीमारियों से बचें।",
            marathi: "आमच्या आधुनिक वैद्यकीय टीमच्या अत्याधुनिक तपासणीद्वारे भावी जुनाट आजारांना वेळीच रोखा."
          },
          posterCta: {
            english: "Book Active Slot",
            hindi: "स्लॉट बुक करें",
            marathi: "वेळ निश्चित करा"
          },
          imagePrompt: "Warm-toned photorealistic medical testing setting",
          whatsappMessage: {
            english: `🚨 *Special Alert from ${payload.clinicName || "Clinic"}*:\nJoin our upcoming Campaign - ${payload.topic || "Imm Immune Shield"}. Safe wellness for all patients. Respond to book.`,
            hindi: `🚨 *${payload.clinicName || "क्लिनिक"} से विशेष अलर्ट*:\nहमारे आगामी अभियान - ${payload.topic || "इम्यून शील्ड"} में शामिल हों। सभी के लिए सुरक्षित स्वास्थ्य। स्लॉट बुक करने के लिए उत्तर दें।`,
            marathi: `🚨 *${payload.clinicName || "क्लिनिक"} कडून विशेष अलर्ट*:\nआमच्या आगामी ${payload.topic || "इम्युन शील्ड"} शिबिरात सहभागी व्हा. सर्वांसाठी निरोगी आरोग्य. बुक करण्यासाठी उत्तर द्या.`
          },
          socialCaption: {
            english: `🩺 Ready to secure your family's health parameters? We're starting our custom initiative: ${payload.topic || "Active Health Booster"}! Let's build a resilient community together. #CarebridgePlus #HealthyLiving #Clinic`,
            hindi: `🩺 क्या आप अपने परिवार के स्वास्थ्य को सुरक्षित करने के लिए तैयार हैं? हम अपनी विशेष पहल शुरू कर रहे हैं: ${payload.topic || "एक्टिव हेल्थ बूस्टर"}! आइए मिलकर एक मजबूत समाज बनाएं। #CarebridgePlus #HealthyLiving #Clinic`,
            marathi: `🩺 आपल्या कुटुंबाचे आरोग्य सुरक्षित ठेवण्यासाठी आपण तयार आहात का? आम्ही आमचा विशेष उपक्रम सुरू करत आहोत: ${payload.topic || "आरोग्य संजीवनी बूस्टर"}! चला एकत्र मिळून निरोगी समाज घडवूया. #CarebridgePlus #HealthyLiving #Clinic`
          },
          suggestedSchedule: {
            english: "Day 1: WhatsApp Broadcast | Day 3: Custom Poster Status | Day 5: SMS Follow-ups | Day 8: Clinic Audits",
            hindi: "दिन 1: व्हाट्सएप ब्रॉडकास्ट | दिन 3: कस्टम पोस्टर रोलआउट | दिन 5: एसएमएस फॉलो-अप | दिन 8: क्लिनिक ऑडिट",
            marathi: "दिवस १: व्हॉट्सअॅप ब्रॉडकास्ट | दिवस ३: कस्टमाइज्ड पोस्टर रोलआउट | दिवस ५: एसएमएस फॉलो-अप | दिवस ८: क्लिनिक तपासणी"
          }
        });
      } else if (type === "content") {
        return res.json({
          english: `🩺 Regular diagnostics save lives! Secure your family parameters with a prompt consultation at ${payload.clinicName || "Carebridge Plus"} today.`,
          marathi: `🩺 नियमित तपासणी आयुष्य वाचवू शकते! आजच ${payload.clinicName || "केअरब्रिज प्लस"} क्लिनिकमध्ये डॉक्टरांशी संपर्क साधा आणि तुमचे आरोग्य सुरक्षित करा.`,
          hindi: `🩺 नियमित स्वास्थ्य जांच जीवन बचा सकती है! आज ही ${payload.clinicName || "केयरब्रिज प्लस"} क्लिनिक से संपर्क करें और अपने परिवार की सेहत सुरक्षित करें।`
        });
      } else if (type === "advisor") {
        return res.json([
          {
            title: "Seasonal Flu & Immuno-Shield Camp",
            description: "Launch a vaccination reminder and general wellness camp to drive patient follow-ups.",
            effort: "Low",
            impact: "High",
            actionPlan: "1. Generate WhatsApp Broadcast\n2. Download Campaign Poster\n3. Register patients on Clinic Floor"
          },
          {
            title: "Diabetes Care & Sugar Alert Hub",
            description: "Organize weekend checkup slots specifically for blood sugar diagnostics and HbA1c screening reminders.",
            effort: "Medium",
            impact: "High",
            actionPlan: "1. Filter chronic patients from ERP dashboard\n2. Send follow-up recalls\n3. Offer special package metrics"
          },
          {
            title: "Local Community Health Seminars",
            description: "Participate in or host small local checkup walks or school camps to introduce new services.",
            effort: "High",
            impact: "Medium",
            actionPlan: "1. Identify active local residential hubs\n2. Distribute printed health awareness materials\n3. Coordinate digital registration feedback loops"
          }
        ]);
      }

      res.status(500).json({ error: "Failed to fallback appropriately." });
    }
  });

  app.post("/api/ai/chat", async (req, res) => {
    try {
      log(`[AI Chat] Request started`);
      if (!apiKey) {
        log(`[AI Chat] Error: API key missing`);
        return res.status(503).json({ error: "AI service not configured" });
      }

      const { message, history = [], language, patientContext, isWarmup } = req.body || {};

      // 1. Support background warmup/preload request on app launch
      if (isWarmup) {
        log(`[AI Chat] Warmup/Preload request received`);
        try {
          const warmupResponse = await generateGeminiContentWithRetry({
            contents: [{ role: 'user', parts: [{ text: "Hello" }] }],
            config: {
              systemInstruction: "Respond with 'Ready'.",
              temperature: 0.1,
            },
            fallbackModel: FALLBACK_MODEL_NAME
          });
          log(`[AI Chat] Warmup/Preload completed, result text: ${warmupResponse?.text}`);
        } catch (warmupErr: any) {
          log(`[AI Chat] Warmup error ignored: ${warmupErr.message}`);
        }
        return res.json({ status: "ready", preloaded: true });
      }

      if (!message || !message.trim()) {
        return res.status(400).json({ error: "Message parameter is required" });
      }

      // 2. Server-Side Response Cache lookup
      const cacheKey = `${language || "English"}_${message.trim().toLowerCase()}_${(patientContext || "").trim().toLowerCase()}`;
      const cached = aiChatResponseCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < CHAT_CACHE_TTL_MS)) {
        log(`[AI Chat] Cache Hit! Serving immediately.`);
        return res.json({ text: cached.responseText });
      }

      // 3. Keep structured history unique and deduplicated
      const cleanHistory = (history || []).map((m: any) => ({
        role: m.role === "model" ? "model" as const : "user" as const,
        parts: m.parts || [{ text: m.text || m.content || "" }]
      }));

      const systemInstruction = `You are "CareBridge AI Health Coach".
      Respond in ${language || 'English'}.
      Context: ${patientContext}

      CRITICAL CLINICAL DIRECTIVES:
      1. Provide direct, highly professional medical guidance based on the available Patient Health Context (vitals, medications, history).
      2. Keep replies conversational, clear, compassionate, and concise. Be responsive to physical complaints or symptoms.
      3. Maintain conversation continuity naturally.
      4. Avoid repeating previously stated information or repeating paragraphs. Refer to facts and continue the dialogue.
      5. If there is a life-threatening emergency, immediately advise calling the standard emergency number 108.
      
      CRITICAL FORMATTING CONTROL: After your medical guidance text, always end with a vertical bar '|' followed by exactly 3 short follow-up questions the patient might want to ask next, separated by semicolons.
      Example: ... standard physical exercises or dietary adjustments can help reduce blood pressure. | How to reduce sodium?; What exercises are safe?; Why is my BP high in morning?`;

      // 4. Remote generation with retry policy
      const response = await generateGeminiContentWithRetry({
        contents: [
          ...cleanHistory,
          { role: 'user' as const, parts: [{ text: message }] }
        ],
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7,
        },
        fallbackModel: FALLBACK_MODEL_NAME
      });

      // 5. In-flight text paragraph deduplication
      const cleanResponseText = deduplicateParagraphs(response.text || "");

      // 6. Save response back to Cache
      aiChatResponseCache.set(cacheKey, {
        responseText: cleanResponseText,
        timestamp: Date.now()
      });

      res.json({ text: cleanResponseText });
    } catch (error: any) {
      const cleanMsg = cleanErrorMessage(error);
      log(`[AI Chat] Error: ${cleanMsg}`);
      res.status(500).json({ error: "AI service limits", details: cleanMsg });
    }
  });

  app.post("/api/ai/diagnosis", async (req, res) => {
    try {
      if (!apiKey) {
        return res.status(503).json({ error: "AI service not configured" });
      }
      const { symptoms, vitals, history, language } = req.body || {};
      
      const prompt = `Based on the following patient data, provide 3 potential diagnosis suggestions (labeled clearly as "suggestions, not final diagnosis") and recommended next steps (which doctor to see or what tests to consider).
      
      Language: ${language || 'English'}
      
      Symptoms: ${symptoms}
      Vitals: ${JSON.stringify(vitals || {})}
      Medical History: ${history}
      
      Format the response nicely in Markdown.`;

      const response = await generateGeminiContentWithRetry({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction: "You are a professional Medical Diagnostic Assistant. Your goal is to provide helpful suggestions while emphasizing that you are an AI and the patient must consult a real doctor.",
          temperature: 0.4,
        },
        fallbackModel: FALLBACK_MODEL_NAME
      });

      res.json({ text: response.text });
    } catch (error: any) {
      const cleanMsg = cleanErrorMessage(error);
      log(`[AI Diagnosis] Error: ${cleanMsg}`);
      res.json({
        text: `### CareBridge Clinical Advisory Fallback\nCurrently, our automated medical analyzer is under high demand or has reached its request limit.\n\n**Next Steps Recommendation:**\n1. Please present your symptoms to your physician at CareBridge for a direct, safe diagnosis.\n2. In case of severe discomfort, please consult our emergency care queue immediately.`
      });
    }
  });

  app.post("/api/ai/prescription-suggestions", async (req, res) => {
    try {
      log(`[AI Prescription] Request started`);
      if (!apiKey) {
        log(`[AI Prescription] Error: API key missing`);
        return res.status(503).json({ error: "AI service not configured" });
      }
      const { complaints, vitals } = req.body || {};
      
      const prompt = `You are an expert medical assistant for a General Physician. 
      Based on these complaints: ${complaints.join(', ')} 
      and vitals: ${JSON.stringify(vitals)}.
      
      Generate a practical prescription in JSON format with the following structure:
      {
        "suggestedDiagnosis": ["Likely Diagnosis 1", "Likely Diagnosis 2"],
        "suggestedAdvice": ["Lifestyle tip 1", "Health advice 2", "Diet tip 3"],
        "suggestedMedicines": [
          {
            "name": "Generic or Brand Name",
            "dose": "e.g., 500mg or Adult/Child",
            "frequency": "e.g., 1-0-1 or Twice Daily",
            "duration": "e.g., 5 Days",
            "timing": "e.g., After Food or Before Food",
            "route": "e.g., Oral",
            "quantity": "e.g., 10"
          }
        ],
        "suggestedInvestigations": ["Test 1 (e.g. CBC)", "Test 2 (e.g. CXR)"]
      }

      Respond ONLY with accurate JSON. Prioritize standard clinical protocols and safety.`;

      try {
        const response = await generateGeminiContentWithRetry({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.4,
          },
          fallbackModel: FALLBACK_MODEL_NAME
        });

        const text = response.text || "{}";
        log(`[AI Prescription] Success`);
        res.json(JSON.parse(text));
      } catch (gemError: any) {
        const cleanMsg = cleanErrorMessage(gemError);
        log(`[AI Prescription Backend Fallback] Gemini API limit reached (${cleanMsg}). Activating local smart clinical fallback.`);
        const backup = getBackupPrescription(complaints, vitals);
        res.json(backup);
      }
    } catch (error: any) {
      const cleanMsg = cleanErrorMessage(error);
      log(`[AI Prescription Fatal] Error: ${cleanMsg}`);
      res.status(500).json({ error: "AI service error", details: cleanMsg });
    }
  });

  app.post("/api/ai/tts", async (req, res) => {
    try {
      log(`[AI TTS] Request started`);
      if (!apiKey) {
        log(`[AI TTS] Error: API key missing`);
        return res.status(503).json({ error: "AI service not configured" });
      }
      const { text } = req.body || {};
      if (!text) {
        return res.status(400).json({ error: "Text parameter is required" });
      }

      log(`[AI TTS] Generating audio for text: ${text}`);

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      const base64Audio = part?.inlineData?.data;
      const mimeType = part?.inlineData?.mimeType;

      if (base64Audio) {
        log(`[AI TTS] Success generating audio`);
        res.json({ audioContent: base64Audio, mimeType: mimeType });
      } else {
        log(`[AI TTS] Error: No audio in response`);
        res.status(500).json({ error: "No audio content in AI response" });
      }
    } catch (error: any) {
      const cleanMsg = cleanErrorMessage(error);
      log(`[AI TTS] Error: ${cleanMsg}`);
      res.status(500).json({ error: "AI service error", details: cleanMsg });
    }
  });

  app.post("/api/ai/medicine-coach", async (req, res) => {
    try {
      log(`[AI Medicine Coach] Request started`);
      if (!apiKey) {
        log(`[AI Medicine Coach] Error: API key missing`);
        return res.status(503).json({ error: "AI service not configured" });
      }

      const { medicines, adherenceScore, logs } = req.body || {};

      const prompt = `You are an AI Medication Management Coach supervising patient treatment.
      
      Patient's configured medicine list:
      ${JSON.stringify(medicines || [])}
      
      Historical intake logs:
      ${JSON.stringify(logs || [])}
      
      Medication adherence score: ${adherenceScore || 100}%
      
      Your goal is to monitor adherence and provide proactive educational, safety-minded, dosage-independent insights and coaching guidelines.
      
      Directives:
      1. Educate the patient on why adhering to their regime is critical.
      2. If adherence is below 90%, gently suggest ways to establish a stronger routine (e.g., matching dosage with standard daily routines, keeping water nearby, setting alarms).
      3. Do NOT modify prescriptions or suggest specific changes to dosages, times, or medicines. This must remain strictly medical doctor-independent.
      4. Highlight any potential safety concerns if there are overlapping medicines (same generic name or same category) or schedule conflicts (multiple tablets at the exact same minute unless standard procedure).
      5. Sound warm, direct, encouraging, and medically sound. Limit your response to 200 words.`;

      const response = await generateGeminiContentWithRetry({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction: "You are the CareBridge AI Supervised Medication Management System Coach. Always structure your responses as helpful, supportive guidelines. Add appropriate health disclaimers.",
          temperature: 0.5,
        },
        fallbackModel: FALLBACK_MODEL_NAME
      });

      res.json({ text: response.text });
    } catch (error: any) {
      const cleanMsg = cleanErrorMessage(error);
      log(`[AI Medicine Coach] Error: ${cleanMsg}`);
      res.json({ text: "### CareBridge AI Coach Feedback\\nCurrently under high demand. Standard guidelines apply: Please check your reminders regularly, ensure you log medication as soon as taken, and never change prescribed dosages without consulting your primary CareBridge doctor." });
    }
  });


  // Database setup
  let db: any = null;
  try {
    log("[Server] Connecting to database...");
    const dbPath = path.resolve(_dirname, "carebridge.db");
    db = new Database(fs.existsSync(dbPath) ? dbPath : path.resolve(process.cwd(), "backend", "carebridge.db"));
    log("[Server] Database connected successfully");
  } catch (error: any) {
    log(`[Server] Database connection error: ${error.message}`);
  }

  // Initialize Database
  try {
    if (db) {
      log("[Server] Initializing database tables...");
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE,
          password TEXT,
          role TEXT,
          name TEXT,
          city TEXT,
          status TEXT DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      
        CREATE TABLE IF NOT EXISTS referrals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_name TEXT,
          patient_age INTEGER,
          patient_phone TEXT,
          patient_gender TEXT,
          patient_condition TEXT,
          department TEXT,
          diagnosis TEXT,
          note TEXT,
          economical_condition TEXT,
          applicable_scheme TEXT,
          doctor_id TEXT,
          doctor_name TEXT,
          clinic_id INTEGER,
          hospital_id INTEGER,
          status TEXT DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_referrals_clinic ON referrals(clinic_id);
        CREATE INDEX IF NOT EXISTS idx_referrals_hospital ON referrals(hospital_id);
        CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
      
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sender_id INTEGER,
          recipient_id INTEGER,
          recipient_role TEXT,
          title TEXT,
          content TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
        CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(recipient_role);
      
        CREATE TABLE IF NOT EXISTS hospital_details (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER UNIQUE,
          tier TEXT DEFAULT 'standard',
          schemes TEXT,
          departments TEXT,
          helpline TEXT,
          address TEXT,
          email TEXT
        );
      
        CREATE TABLE IF NOT EXISTS hospital_doctors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hospital_id INTEGER,
          name TEXT,
          qualification TEXT,
          contact TEXT
        );
      
        CREATE TABLE IF NOT EXISTS clinic_details (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER UNIQUE,
          degree TEXT,
          reg_no TEXT,
          address TEXT,
          rating INTEGER DEFAULT 5,
          doctor_name TEXT,
          qualification TEXT,
          contact_no TEXT,
          tier TEXT,
          email TEXT
        );
      `);
      
      // Fast migration check
      const tables = ['hospital_details', 'referrals', 'clinic_details'];
      tables.forEach(table => {
        const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        const cols = info.map(c => c.name);
        
        if (table === 'hospital_details') {
          if (!cols.includes('email')) db.exec("ALTER TABLE hospital_details ADD COLUMN email TEXT");
          if (!cols.includes('address')) db.exec("ALTER TABLE hospital_details ADD COLUMN address TEXT");
        } else if (table === 'referrals') {
          if (!cols.includes('patient_gender')) db.exec("ALTER TABLE referrals ADD COLUMN patient_gender TEXT");
          if (!cols.includes('patient_condition')) db.exec("ALTER TABLE referrals ADD COLUMN patient_condition TEXT");
          if (!cols.includes('doctor_id')) db.exec("ALTER TABLE referrals ADD COLUMN doctor_id TEXT");
          if (!cols.includes('doctor_name')) db.exec("ALTER TABLE referrals ADD COLUMN doctor_name TEXT");
        } else if (table === 'clinic_details') {
          const needed = ['doctor_name', 'qualification', 'contact_no', 'reg_no', 'email', 'rating', 'tier'];
          needed.forEach(col => {
            if (!cols.includes(col)) db.exec(`ALTER TABLE clinic_details ADD COLUMN ${col} ${col === 'rating' ? 'INTEGER' : 'TEXT'}`);
          });
        }
      });
      
      // Seed initial users if empty
      const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
      if (userCount.count === 0) {
        log("[Server] Seeding initial data...");
        // Admin
        db.prepare("INSERT INTO users (username, password, role, name, city, status) VALUES (?, ?, ?, ?, ?, ?)").run(
          "PLUSADMIN", "plus@098", "admin", "Master Admin", "System", "active"
        );

        // Hospitals
        const hospitals = [
          ["PLUSHOSPITAL", "plus@098", "hospital", "CareBridge+ Hospital", "Aurangabad", "active"],
          ["CITYHOSP", "plus@098", "hospital", "City General Hospital", "Aurangabad", "active"],
          ["APEXHOSP", "plus@098", "hospital", "Apex Multispeciality", "Pune", "active"],
          ["SUNRISEHOSP", "plus@098", "hospital", "Sunrise Children's Hospital", "Mumbai", "active"],
          ["NEWLIFEHOSP", "plus@098", "hospital", "New Life Hospital", "Jalna", "pending"],
          ["METROCARE", "plus@098", "hospital", "Metro Care Hospital", "Pune", "pending"]
        ];
        hospitals.forEach(h => {
          db.prepare("INSERT INTO users (username, password, role, name, city, status) VALUES (?, ?, ?, ?, ?, ?)").run(...h);
        });

        // Clinics
        const clinics = [
          ["PLUSCLINIC", "plus@098", "clinic", "Patil Clinic", "Aurangabad", "active"],
          ["SHARMACLINIC", "plus@098", "clinic", "Sharma Family Clinic", "Aurangabad", "active"],
          ["WELLNESSCLINIC", "plus@098", "clinic", "Wellness Health Center", "Jalna", "active"],
          ["METRODENTAL", "plus@098", "clinic", "Metro Dental Clinic", "Pune", "active"],
          ["GLOBALEYE", "plus@098", "clinic", "Global Eye Care", "Mumbai", "active"],
          ["LIFELINECLINIC", "plus@098", "clinic", "LifeLine Clinic", "Aurangabad", "active"],
          ["GUPTACLINIC", "plus@098", "clinic", "Dr. Gupta's Clinic", "Pune", "pending"],
          ["HOPECLINIC", "plus@098", "clinic", "Hope Medical Center", "Mumbai", "pending"],
          ["CITYCLINIC", "plus@098", "clinic", "City Health Clinic", "Jalna", "pending"]
        ];
        clinics.forEach(c => {
          db.prepare("INSERT INTO users (username, password, role, name, city, status) VALUES (?, ?, ?, ?, ?, ?)").run(...c);
        });

        // Seed details for Hospitals
        const hospitalUsers = db.prepare("SELECT id, name FROM users WHERE role = 'hospital'").all() as any[];
        hospitalUsers.forEach(u => {
          db.prepare("INSERT INTO hospital_details (user_id, tier, schemes, departments, helpline, address) VALUES (?, ?, ?, ?, ?, ?)").run(
            u.id, 
            u.name === "CareBridge+ Hospital" ? "premium" : "priority", 
            "MJPJAY, PMJAY, Cashless", 
            "Orthopedics, Cardiology, Gynecology, Neurology", 
            "0240-1234567",
            `Main Road, ${u.name}`
          );
        });

        // Seed details for Clinics
        const clinicUsers = db.prepare("SELECT id, name FROM users WHERE role = 'clinic'").all() as any[];
        clinicUsers.forEach(u => {
          db.prepare("INSERT INTO clinic_details (user_id, degree, reg_no, address, doctor_name, qualification, contact_no) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            u.id, "MBBS, MD", `MMC-${10000 + u.id}`, `Clinic Street, ${u.name}`, `Dr. ${u.name.split(' ')[0]}`, "MBBS, MD", "9988776655"
          );
        });
      }
      log("[Server] Database initialization complete");
    }
  } catch (error) {
    log(`[Server] Database initialization error: ${error}`);
  }

  app.get("/api/debug", (req, res) => {
    const isProd = getIsProd();
    res.json({
      headers: req.headers,
      url: req.url,
      method: req.method,
      isProd
    });
  });

  app.post("/api/login", (req, res) => {
    if (!db) return res.status(503).json({ message: "Database not ready" });
    const { username, password } = req.body;
    console.log(`[Server] Login attempt for username: ${username}`);
    
    try {
      // Use COLLATE NOCASE for case-insensitive username matching
      const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND password = ?").get(username, password) as any;
      
      if (user) {
        console.log(`[Server] Login successful for: ${username}`);
        res.json({ success: true, user });
      } else {
        console.log(`[Server] Login failed for: ${username} - Invalid credentials`);
        res.status(401).json({ success: false, message: "Invalid username or password" });
      }
    } catch (error) {
      console.error("[Server] Login error:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.post("/api/register", (req, res) => {
    if (!db) return res.status(503).json({ message: "Database not ready" });
    const { username, password, role, name, city, details } = req.body;
    
    try {
      // Check if user exists
      const existingUser = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
      if (existingUser) {
        return res.status(400).json({ success: false, message: "Username already exists" });
      }

      db.transaction(() => {
        const result = db.prepare("INSERT INTO users (username, password, role, name, city, status) VALUES (?, ?, ?, ?, ?, 'pending')")
          .run(username, password, role, name, city);
        const userId = result.lastInsertRowid;

        if (role === 'hospital') {
          db.prepare("INSERT INTO hospital_details (user_id, tier, schemes, departments, helpline, address, email) VALUES (?, 'standard', '', '', ?, ?, ?)")
            .run(userId, details.helpline || '', details.address || '', details.email || '');
        } else if (role === 'clinic') {
          db.prepare("INSERT INTO clinic_details (user_id, degree, reg_no, address, rating, doctor_name, qualification, contact_no, email) VALUES (?, ?, ?, ?, 5, ?, ?, ?, ?)")
            .run(userId, details.degree || '', details.reg_no || '', details.address || '', details.doctor_name || name, details.qualification || '', details.contact_no || '', details.email || '');
        }
      })();

      res.json({ success: true, message: "Registration successful. Waiting for admin approval." });
    } catch (error) {
      console.error("[Server] Registration error:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.get("/api/hospitals", (req, res) => {
    try {
      const hospitals = db.prepare(`
        SELECT u.id, u.name, u.city, u.status, hd.tier, hd.schemes, hd.departments, hd.helpline, hd.address, hd.email
        FROM users u 
        JOIN hospital_details hd ON u.id = hd.user_id 
        WHERE u.role = 'hospital'
      `).all();
      res.json(hospitals);
    } catch (error) {
      console.error("[Server] Error fetching hospitals:", error);
      res.status(500).json({ success: false, message: "Failed to fetch hospitals" });
    }
  });

  app.get("/api/hospitals/:user_id", (req, res) => {
    try {
      const hospital = db.prepare(`
        SELECT u.id, u.name, u.city, hd.tier, hd.schemes, hd.departments, hd.helpline, hd.address, hd.email
        FROM users u
        JOIN hospital_details hd ON u.id = hd.user_id
        WHERE u.id = ?
      `).get(req.params.user_id);
      
      if (hospital) {
        const doctors = db.prepare("SELECT * FROM hospital_doctors WHERE hospital_id = ?").all(req.params.user_id);
        res.json({ ...hospital, doctors });
      } else {
        res.status(404).json({ message: "Hospital not found" });
      }
    } catch (error) {
      console.error("[Server] Error fetching hospital detail:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.patch("/api/hospitals/:user_id/profile", (req, res) => {
    const { name, city, helpline, address, departments, schemes, email } = req.body;
    
    db.transaction(() => {
      db.prepare("UPDATE users SET name = ?, city = ? WHERE id = ?").run(name, city, req.params.user_id);
      db.prepare("UPDATE hospital_details SET helpline = ?, address = ?, departments = ?, schemes = ?, email = ? WHERE user_id = ?")
        .run(helpline, address, departments, schemes, email, req.params.user_id);
    })();
    
    res.json({ success: true });
  });

  app.post("/api/hospitals/:user_id/doctors", (req, res) => {
    const { name, qualification, contact } = req.body;
    db.prepare("INSERT INTO hospital_doctors (hospital_id, name, qualification, contact) VALUES (?, ?, ?, ?)")
      .run(req.params.user_id, name, qualification, contact);
    res.json({ success: true });
  });

  app.delete("/api/doctors/:id", (req, res) => {
    db.prepare("DELETE FROM hospital_doctors WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  });

  app.get("/api/clinics", (req, res) => {
    try {
      const clinics = db.prepare(`
        SELECT u.id, u.name, u.city, u.status, cd.degree, cd.reg_no, cd.address, cd.rating, cd.tier, cd.doctor_name, cd.qualification, cd.contact_no, cd.email
        FROM users u 
        JOIN clinic_details cd ON u.id = cd.user_id 
        WHERE u.role = 'clinic'
      `).all();
      res.json(clinics);
    } catch (error) {
      console.error("[Server] Error fetching clinics:", error);
      res.status(500).json([]);
    }
  });

  app.get("/api/clinics/:user_id", (req, res) => {
    try {
      const clinic = db.prepare(`
        SELECT u.id, u.name, u.city, cd.degree, cd.reg_no, cd.address, cd.rating, cd.tier, cd.doctor_name, cd.qualification, cd.contact_no, cd.email
        FROM users u
        JOIN clinic_details cd ON u.id = cd.user_id
        WHERE u.id = ?
      `).get(req.params.user_id);
      
      if (clinic) {
        res.json(clinic);
      } else {
        res.status(404).json({ message: "Clinic not found" });
      }
    } catch (error) {
      console.error("[Server] Error fetching clinic detail:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.patch("/api/clinics/:user_id/profile", (req, res) => {
    try {
      const { name, address, doctor_name, qualification, reg_no, contact_no, email } = req.body;
      db.transaction(() => {
        db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.params.user_id);
        db.prepare("UPDATE clinic_details SET address = ?, doctor_name = ?, qualification = ?, reg_no = ?, contact_no = ?, email = ? WHERE user_id = ?")
          .run(address, doctor_name, qualification, reg_no, contact_no, email, req.params.user_id);
      })();
      res.json({ success: true });
    } catch (error) {
      console.error("[Server] Error updating clinic profile:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.get("/api/approvals", (req, res) => {
    try {
      const pending = db.prepare(`
        SELECT u.*, 
               hd.address as hospital_address, hd.helpline as hospital_helpline,
               cd.address as clinic_address, cd.contact_no as clinic_contact, cd.doctor_name, cd.qualification
        FROM users u
        LEFT JOIN hospital_details hd ON u.id = hd.user_id
        LEFT JOIN clinic_details cd ON u.id = cd.user_id
        WHERE u.status = 'pending'
      `).all();
      res.json(pending);
    } catch (error) {
      console.error("[Server] Error fetching approvals:", error);
      res.status(500).json([]);
    }
  });

  app.post("/api/approvals/request", (req, res) => {
    const { user_id, name, role } = req.body;
    try {
      // Find admin to send message to
      const admin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as any;
      if (admin) {
        db.prepare("INSERT INTO messages (sender_id, recipient_id, recipient_role, title, content) VALUES (?, ?, ?, ?, ?)")
          .run(user_id, admin.id, 'admin', 'Approval Request', `${role.toUpperCase()} ${name} is requesting dashboard access.`);
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error sending request" });
    }
  });

  app.post("/api/referrals", (req, res) => {
    const { patient_name, patient_age, patient_phone, patient_gender, patient_condition, department, diagnosis, note, economical_condition, doctor_id, doctor_name, clinic_id, hospital_id } = req.body;
    const result = db.prepare(`
      INSERT INTO referrals (patient_name, patient_age, patient_phone, patient_gender, patient_condition, department, diagnosis, note, economical_condition, doctor_id, doctor_name, clinic_id, hospital_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(patient_name, patient_age, patient_phone, patient_gender, patient_condition, department, diagnosis, note, economical_condition, doctor_id, doctor_name, clinic_id, hospital_id);
    res.json({ success: true, id: result.lastInsertRowid });
  });

  app.get("/api/referrals", (req, res) => {
    try {
      const { role, id } = req.query;
      let query = `
        SELECT r.*, u_clinic.name as clinic_name, u_hosp.name as hospital_name, u_hosp.city as hospital_city,
               cd.contact_no as clinic_contact
        FROM referrals r
        JOIN users u_clinic ON r.clinic_id = u_clinic.id
        JOIN users u_hosp ON r.hospital_id = u_hosp.id
        LEFT JOIN clinic_details cd ON r.clinic_id = cd.user_id
      `;
      if (role === 'clinic') {
        query += " WHERE r.clinic_id = ?";
      } else if (role === 'hospital') {
        query += " WHERE r.hospital_id = ?";
      }
      query += " ORDER BY r.created_at DESC";
      
      const referrals = role ? db.prepare(query).all(id) : db.prepare(query).all();
      res.json(referrals);
    } catch (error) {
      console.error("[Server] Error fetching referrals:", error);
      res.status(500).json([]);
    }
  });

  app.post("/api/messages", (req, res) => {
    const { sender_id, recipient_id, recipient_role, title, content } = req.body;
    db.prepare(`
      INSERT INTO messages (sender_id, recipient_id, recipient_role, title, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(sender_id, recipient_id, recipient_role, title, content);
    res.json({ success: true });
  });

  app.get("/api/messages", (req, res) => {
    try {
      const { user_id, role } = req.query;
      const messages = db.prepare(`
        SELECT m.*, u.name as sender_name, u.role as sender_role
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.recipient_id = ? OR m.recipient_role = ? OR m.recipient_role = 'all'
        ORDER BY m.created_at DESC
      `).all(user_id, role);
      res.json(messages);
    } catch (error) {
      console.error("[Server] Error fetching messages:", error);
      res.status(500).json([]);
    }
  });

  app.get("/api/users/:id", (req, res) => {
    try {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
      if (user) {
        res.json(user);
      } else {
        res.status(404).json({ message: "User not found" });
      }
    } catch (error) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.patch("/api/users/:id/status", (req, res) => {
    try {
      const { status } = req.body;
      db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("[Server] Error updating user status:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.patch("/api/referrals/:id/status", (req, res) => {
    try {
      const { status } = req.body;
      db.prepare("UPDATE referrals SET status = ? WHERE id = ?").run(status, req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("[Server] Error updating referral status:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.patch("/api/hospital_details/:user_id/tier", (req, res) => {
    try {
      const { tier } = req.body;
      db.prepare("UPDATE hospital_details SET tier = ? WHERE user_id = ?").run(tier, req.params.user_id);
      res.json({ success: true });
    } catch (error) {
      console.error("[Server] Error updating hospital tier:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.patch("/api/clinic_details/:user_id/tier", (req, res) => {
    try {
      const { tier } = req.body;
      db.prepare("UPDATE clinic_details SET tier = ? WHERE user_id = ?").run(tier, req.params.user_id);
      res.json({ success: true });
    } catch (error) {
      console.error("[Server] Error updating clinic tier:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  app.patch("/api/clinic_details/:user_id/rating", (req, res) => {
    try {
      const { rating } = req.body;
      db.prepare("UPDATE clinic_details SET rating = ? WHERE user_id = ?").run(rating, req.params.user_id);
      res.json({ success: true });
    } catch (error) {
      console.error("[Server] Error updating clinic rating:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  // Catch-all for API routes that don't match
  app.all("/api/*", (req, res) => {
    log(`[404] API route not found: ${req.method} ${req.url}`);
    res.status(404).json({ success: false, message: "API endpoint not found" });
  });

  // Vite middleware for development
  const isProd = getIsProd();
  const distPath = path.join(process.cwd(), "dist");
  const distExists = fs.existsSync(distPath);
  
  log(`[Server] Mode: ${isProd ? "Production" : "Development"}`);
  log(`[Server] NODE_ENV: ${process.env.NODE_ENV}`);
  log(`[Server] VITE_PROD: ${process.env.VITE_PROD}`);
  log(`[Server] Checking for dist at: ${distPath} (Exists: ${distExists})`);
  
  if (isProd && distExists) {
    log("[Server] Production mode: Serving static files from dist...");
    app.use(express.static(distPath));
    
    // SPA Fallback: Serve index.html for all non-API routes
    app.get("*", (req, res, next) => {
      // Skip API and health routes
      if (req.url.startsWith('/api') || req.url === '/ping' || req.url === '/hello' || req.url === '/health') {
        log(`[404] API or Health route not found: ${req.url}`);
        return next();
      }
      
      log(`[SPA] Serving index.html for: ${req.url}`);
      const indexPath = path.join(distPath, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        log(`[Error] index.html not found at: ${indexPath}`);
        res.status(404).send("Application build not found. Please run 'npm run build' first.");
      }
    });
  } else {
    log("[Server] Falling back to Vite middleware (Development or missing dist)...");
    try {
      const { createServer: createViteServer } = await import("vite");
      const frontendRoot = path.resolve(process.cwd(), "frontend");
      const vite = await createViteServer({
        root: frontendRoot,
        configFile: path.resolve(frontendRoot, "vite.config.ts"),
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (err: any) {
      log(`[Fatal] Failed to start Vite: ${err.message}`);
      if (isProd) {
        log("[Fatal] ERROR: dist directory is missing in production mode and Vite failed to start.");
      }
      process.exit(1);
    }
  }

  // Start listening at the very end
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    log(`[Error] Global error handler: ${err.message}\n${err.stack}`);
    res.status(500).send("Internal Server Error");
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    log(`[Server] Listening on 0.0.0.0:${PORT}`);
    log(`[Server] Local URL: http://localhost:${PORT}`);
    log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  server.on('error', (err) => {
    console.error('[Server] Listen error:', err);
  });
}

log("[Server] Script loaded, calling startServer()...");
startServer().catch(err => {
  log(`[Server] Fatal error during startup: ${err.message}\n${err.stack}`);
});

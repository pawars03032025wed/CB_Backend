import nodemailer, { Transporter } from 'nodemailer';

// Generate a test SMTP service account from ethereal.email
// In production, these should be environment variables.
let transporter: Transporter | null = null;

async function initTransporter() {
  if (transporter) return transporter;
  
  try {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    console.log("[Email Service] Initialized Ethereal Email test account.");
    return transporter;
  } catch (error) {
    console.error("[Email Service] Failed to initialize Ethereal test account:", error);
    return null;
  }
}

interface PaymentEmailOptions {
  toEmail: string;
  name: string;
  plan: string;
  amount: number;
  paymentMethod: string;
  transactionId: string;
  paymentId: string;
  date: string;
  time: string;
  subscriptionStart: string;
  subscriptionEnd: string;
}

export async function sendPaymentSuccessEmail(options: PaymentEmailOptions): Promise<{ success: boolean; messageId?: string }> {
  try {
    const t = await initTransporter();
    if (!t) throw new Error("Transporter not initialized");

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
        <h2 style="color: #2b6cb0;">Carebridge+ Payment Successful — Thank You</h2>
        <p>Hello <strong>${options.name}</strong>,</p>
        <p>Thank you for your payment to Carebridge+.</p>
        <p>Your payment has been successfully received and your Carebridge+ subscription is now active.</p>
        
        <div style="background-color: #f7fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #4a5568; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">Payment Details</h3>
          <p><strong>Name:</strong> ${options.name}</p>
          <p><strong>Plan:</strong> ${options.plan}</p>
          <p><strong>Amount Paid:</strong> ₹${options.amount}</p>
          <p><strong>Payment Method:</strong> ${options.paymentMethod}</p>
          <p><strong>Transaction ID:</strong> ${options.transactionId}</p>
          <p><strong>Payment ID:</strong> ${options.paymentId}</p>
          <p><strong>Payment Date:</strong> ${options.date}</p>
          <p><strong>Payment Time:</strong> ${options.time}</p>
          <p><strong>Subscription Start:</strong> ${options.subscriptionStart}</p>
          <p><strong>Subscription Valid Till:</strong> ${options.subscriptionEnd}</p>
          <p><strong>Payment Status:</strong> <span style="color: #48bb78; font-weight: bold;">SUCCESSFUL</span></p>
        </div>

        <p>Thank you for choosing Carebridge+.</p>
        <p>We are happy to have you with us.</p>
        <br/>
        <p>Thank You,<br/><strong>Carebridge+ Team</strong></p>
      </div>
    `;

    const info = await t.sendMail({
      from: '"Carebridge+ Billing" <billing@carebridgeplus.com>',
      to: options.toEmail,
      subject: "Carebridge+ Payment Successful — Thank You",
      html: htmlBody,
    });

    console.log("[Email Service] Payment Success email sent to %s", options.toEmail);
    console.log("[Email Service] Preview URL: %s", nodemailer.getTestMessageUrl(info));

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("[Email Service] Error sending email:", error);
    return { success: false };
  }
}

export async function sendWelcomeEmail(options: { toEmail: string; accountType: string; name: string }) {
  try {
    const t = await initTransporter();
    
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <h2 style="color: #0077b6;">Welcome to the CareBridge+ Family!</h2>
        <p>Hi ${options.name},</p>
        <p>Your registration as a <strong>${options.accountType.toUpperCase()}</strong> was successful and your credentials have been securely saved.</p>
        <p>We are thrilled to have you with us. You can now log in and explore all the features we have tailored for you.</p>
        <br/>
        <p>Thank You,<br/><strong>Carebridge+ Team</strong></p>
      </div>
    `;

    const info = await t.sendMail({
      from: '"Carebridge+ Welcome" <welcome@carebridgeplus.com>',
      to: options.toEmail,
      subject: "Registration Successful — Welcome to Carebridge+ Family",
      html: htmlBody,
    });

    console.log("[Email Service] Welcome email sent to %s", options.toEmail);
    console.log("[Email Service] Preview URL: %s", nodemailer.getTestMessageUrl(info));

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("[Email Service] Error sending welcome email:", error);
    return { success: false };
  }
}

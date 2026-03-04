import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { activateTemplate } from '@/lib/optimization/template-versioning';
import { z } from 'zod';
import mongoose from 'mongoose';

const requestSchema = z.object({
  templateId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    // 1. Auth: Admin-only
    const session = await auth();
    if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse and validate request
    const body = await req.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { templateId } = parsed.data;

    // 3. Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return NextResponse.json({ error: 'Invalid template ID' }, { status: 400 });
    }

    await connectDB();

    // 4. Activate template
    const template = await activateTemplate(new mongoose.Types.ObjectId(templateId));

    // 5. Return updated template
    return NextResponse.json({
      template: {
        id: template._id.toString(),
        tradingStyle: template.tradingStyle,
        version: template.version,
        weights: template.weights,
        thresholds: template.thresholds,
        performanceMetrics: template.performanceMetrics,
        active: template.active,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      },
    });
  } catch (error) {
    console.error('Template activation error:', error instanceof Error ? error.message : 'Unknown error');

    if (error instanceof Error && error.message === 'Template not found') {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

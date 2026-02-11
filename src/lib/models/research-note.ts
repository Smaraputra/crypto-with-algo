import mongoose, { Schema, type Document } from 'mongoose';

export const RESEARCH_NOTE_CATEGORIES = [
  'strategy',
  'concept',
  'rule',
  'checklist',
  'observation',
] as const;

export type ResearchNoteCategory = (typeof RESEARCH_NOTE_CATEGORIES)[number];

export interface IResearchNote extends Document {
  userId: string;
  title: string;
  content: string;
  category: ResearchNoteCategory;
  tags: string[];
  relatedSymbols: string[];
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const researchNoteSchema = new Schema<IResearchNote>(
  {
    userId: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    content: { type: String, default: '' },
    category: {
      type: String,
      enum: RESEARCH_NOTE_CATEGORIES,
      required: true,
    },
    tags: { type: [String], default: [] },
    relatedSymbols: { type: [String], default: [] },
    isPinned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

researchNoteSchema.index({ userId: 1, createdAt: -1 });
researchNoteSchema.index({ userId: 1, category: 1 });
researchNoteSchema.index({ userId: 1, tags: 1 });

export const MAX_RESEARCH_NOTES_PER_USER = 200;

export const ResearchNote =
  mongoose.models.ResearchNote ||
  mongoose.model<IResearchNote>('ResearchNote', researchNoteSchema);

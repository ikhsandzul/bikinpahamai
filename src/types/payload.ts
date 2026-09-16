export type TargetLevel = 'SD_SMP' | 'SMA_SMK' | 'MAHASISWA';

export interface SummaryTopic {
  topic: string;
  key_points: string[];
  explanation: string;
}

export interface FlashcardItem {
  id: number;
  front: string;
  back: string;
}

export interface QuizQuestion {
  id: number;
  question: string;
  options: string[];
  correct_answer: string;
  explanation: string;
}

export interface BikinPahamPayload {
  document_meta: {
    title: string;
    target_level: TargetLevel;
  };
  summary_module: SummaryTopic[];
  flashcards: FlashcardItem[];
  quiz_exam: QuizQuestion[];
}
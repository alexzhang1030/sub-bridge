import { asRecord } from "./lib/record";

function trimNonEmpty(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

type PlanStepStatus = "completed" | "in_progress" | "pending";

function normalizePlanStepStatus(raw: unknown): PlanStepStatus {
  switch (raw) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "in_progress";
    default:
      return "pending";
  }
}

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface AskQuestionOption {
  id: string;
  label: string;
}

export interface AskQuestion {
  id: string;
  prompt: string;
  allowMultiple: boolean;
  options: AskQuestionOption[];
}

export function planStepsFromSessionUpdate(update: unknown): PlanStep[] {
  const record = asRecord(update);
  const entries = Array.isArray(record?.entries) ? record.entries : [];
  return entries.flatMap((entry, index) => {
    const entryRecord = asRecord(entry);
    const step = trimNonEmpty(entryRecord?.content) ?? `Step ${index + 1}`;
    return [{ step, status: normalizePlanStepStatus(entryRecord?.status) }];
  });
}

export function extractPlanMarkdown(params: unknown): string {
  return trimNonEmpty(asRecord(params)?.plan) ?? "# Plan\n\n(Cursor did not supply plan text.)";
}

export function extractTodosAsPlan(params: unknown): { steps: PlanStep[] } {
  const record = asRecord(params);
  const todos = Array.isArray(record?.todos) ? record.todos : [];
  const steps = todos.flatMap((todo) => {
    const todoRecord = asRecord(todo);
    const step = trimNonEmpty(todoRecord?.content) ?? trimNonEmpty(todoRecord?.title);
    if (!step) return [];
    return [{ step, status: normalizePlanStepStatus(todoRecord?.status) }];
  });
  return { steps };
}

export function summarizePlanSteps(steps: PlanStep[]): string {
  if (!Array.isArray(steps) || steps.length === 0) return "";
  const preview = steps.slice(0, 3).map((entry) => entry.step).join("; ");
  if (steps.length <= 3) return preview;
  return `${preview}; +${steps.length - 3} more`;
}

export function extractAskQuestions(params: unknown): AskQuestion[] {
  const record = asRecord(params);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  return questions.map((question) => {
    const questionRecord = asRecord(question);
    return {
      id: trimNonEmpty(questionRecord?.id) ?? "question",
      prompt: trimNonEmpty(questionRecord?.prompt) ?? "Question",
      allowMultiple: questionRecord?.allowMultiple === true,
      options: Array.isArray(questionRecord?.options)
        ? questionRecord.options
            .map((option) => {
              const optionRecord = asRecord(option);
              return {
                id: trimNonEmpty(optionRecord?.id) ?? trimNonEmpty(optionRecord?.label) ?? "option",
                label: trimNonEmpty(optionRecord?.label) ?? trimNonEmpty(optionRecord?.id) ?? "Option",
              };
            })
            .filter((option) => option.label)
        : [],
    };
  });
}

export function autoAnswersForQuestions(questions: AskQuestion[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const first = question.options?.[0];
    answers[question.id] = first?.id || first?.label || "";
  }
  return answers;
}

export function summarizeQuestions(questions: AskQuestion[], answers: Record<string, string> | undefined): string {
  const lines: string[] = [];
  for (const question of questions) {
    const selected = answers?.[question.id];
    const label =
      question.options?.find((option) => option.id === selected || option.label === selected)?.label ||
      selected ||
      "(auto)";
    lines.push(`${question.prompt}: ${label}`);
  }
  return lines.join("\n");
}

export function askUserArgumentsFromQuestions(questions: AskQuestion[]): { question: string; choices?: string[] } | null {
  const first = questions[0];
  if (!first) return null;
  const choices = first.options?.map((option) => option.label).filter(Boolean) ?? [];
  return {
    question: first.prompt,
    ...(choices.length > 0 ? { choices } : {}),
  };
}

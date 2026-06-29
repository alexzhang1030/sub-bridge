// @ts-nocheck
function trimNonEmpty(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function normalizePlanStepStatus(raw) {
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

export function planStepsFromSessionUpdate(update) {
  const entries = Array.isArray(update?.entries) ? update.entries : [];
  return entries.flatMap((entry, index) => {
    const step = trimNonEmpty(entry?.content) ?? `Step ${index + 1}`;
    return [{ step, status: normalizePlanStepStatus(entry?.status) }];
  });
}

export function extractPlanMarkdown(params) {
  return trimNonEmpty(params?.plan) ?? "# Plan\n\n(Cursor did not supply plan text.)";
}

export function extractTodosAsPlan(params) {
  const todos = Array.isArray(params?.todos) ? params.todos : [];
  const steps = todos.flatMap((todo) => {
    const step = trimNonEmpty(todo?.content) ?? trimNonEmpty(todo?.title);
    if (!step) return [];
    return [{ step, status: normalizePlanStepStatus(todo?.status) }];
  });
  return { steps };
}

export function summarizePlanSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return "";
  const preview = steps.slice(0, 3).map((entry) => entry.step).join("; ");
  if (steps.length <= 3) return preview;
  return `${preview}; +${steps.length - 3} more`;
}

export function extractAskQuestions(params) {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  return questions.map((question) => ({
    id: trimNonEmpty(question?.id) ?? "question",
    prompt: trimNonEmpty(question?.prompt) ?? "Question",
    allowMultiple: question?.allowMultiple === true,
    options: Array.isArray(question?.options)
      ? question.options
          .map((option) => ({
            id: trimNonEmpty(option?.id) ?? trimNonEmpty(option?.label) ?? "option",
            label: trimNonEmpty(option?.label) ?? trimNonEmpty(option?.id) ?? "Option",
          }))
          .filter((option) => option.label)
      : [],
  }));
}

export function autoAnswersForQuestions(questions) {
  const answers = {};
  for (const question of questions) {
    const first = question.options?.[0];
    answers[question.id] = first?.id || first?.label || "";
  }
  return answers;
}

export function summarizeQuestions(questions, answers) {
  const lines = [];
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

export function askUserArgumentsFromQuestions(questions) {
  const first = questions[0];
  if (!first) return null;
  const choices = first.options?.map((option) => option.label).filter(Boolean) ?? [];
  return {
    question: first.prompt,
    ...(choices.length > 0 ? { choices } : {}),
  };
}

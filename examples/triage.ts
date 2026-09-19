import { experimental_evaluate as evaluate } from 'ai';

const model = process.env.AI_GATEWAY_MODEL || 'typesafe-ai/jev';

const message =
  process.argv.slice(2).join(' ') ||
  'I was charged twice for my subscription this month. Please refund the extra charge.';

const result = await evaluate({
  model,
  state: { message },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this message?',
      criteria: {
        billing: 'Payments, charges, invoices, and refunds',
        technical: 'Bugs, errors, and product not working',
        sales: 'Pricing questions, upgrades, and new purchases',
        other: 'Anything else',
      },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is the issue for the customer?',
      criteria: ['Cosmetic or informational', 'Inconvenient, workaround exists', 'Blocking; no workaround'],
    },
    requestsRefund: {
      type: 'boolean',
      instructions: 'Is the customer asking for money back?',
    },
  },
});

const { department, severity, requestsRefund } = result.answers;

console.log('Message:     ', message);
console.log('Department:  ', department.choice, department.probabilities ?? '');
console.log('Severity:    ', severity.score.toFixed(2), '/ 2');
console.log('Refund P:    ', requestsRefund.probability.toFixed(3));
console.log('Model:       ', result.response.modelId);
console.log('Usage:       ', result.usage);

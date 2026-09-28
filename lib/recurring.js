export const RECURRING_FREQUENCIES = ['daily','weekly','monthly','yearly'];

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('Invalid recurrence date.');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Invalid recurrence date.');
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0,10);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function nextRecurringDate(currentDate, frequency, interval = 1, anchorDate = currentDate) {
  if (!RECURRING_FREQUENCIES.includes(frequency)) throw new Error('Invalid recurrence frequency.');
  const step = Number(interval);
  if (!Number.isInteger(step) || step < 1 || step > 99) throw new Error('Invalid recurrence interval.');
  const current = parseDate(currentDate);
  const anchor = parseDate(anchorDate || currentDate);

  if (frequency === 'daily') {
    current.setUTCDate(current.getUTCDate() + step);
    return formatDate(current);
  }
  if (frequency === 'weekly') {
    current.setUTCDate(current.getUTCDate() + (7 * step));
    return formatDate(current);
  }
  if (frequency === 'monthly') {
    const target = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + step, 1));
    const day = Math.min(anchor.getUTCDate(), daysInMonth(target.getUTCFullYear(), target.getUTCMonth()));
    target.setUTCDate(day);
    return formatDate(target);
  }

  const targetYear = current.getUTCFullYear() + step;
  const month = anchor.getUTCMonth();
  const day = Math.min(anchor.getUTCDate(), daysInMonth(targetYear, month));
  return formatDate(new Date(Date.UTC(targetYear, month, day)));
}

export function daysBetween(fromDate, toDate) {
  return Math.round((parseDate(toDate).getTime() - parseDate(fromDate).getTime()) / 86400000);
}

export function recurringStatus(rule, today) {
  if (!rule?.isActive) return { key:'paused', label:'Paused', days:null };
  if (!rule.nextDueDate) return { key:'complete', label:'Complete', days:null };
  const days = daysBetween(today, rule.nextDueDate);
  if (days < 0) return { key:'overdue', label:Math.abs(days) === 1 ? '1 day overdue' : (Math.abs(days) + ' days overdue'), days };
  if (days === 0) return { key:'due', label:'Due today', days };
  if (days === 1) return { key:'upcoming', label:'Due tomorrow', days };
  return { key:'upcoming', label:'Due in ' + days + ' days', days };
}

export function shouldRemind(rule, today) {
  if (!rule?.isActive || !rule.nextDueDate) return false;
  const days = daysBetween(today, rule.nextDueDate);
  return days <= Number(rule.remindDaysBefore || 0);
}

export function recurrenceLabel(rule) {
  const n = Number(rule?.interval || 1);
  const labels = { daily:'day', weekly:'week', monthly:'month', yearly:'year' };
  const unit = labels[rule?.frequency] || 'period';
  return n === 1 ? ('Every ' + unit) : ('Every ' + n + ' ' + unit + 's');
}

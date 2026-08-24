import { redirect } from 'next/navigation'

/** Az ütemezett feladatok a boardon élnek — a külön menüpont megszűnt. */
export default function ScheduledTasksRedirectPage() {
  redirect('/control-plane/board?scheduled=1')
}

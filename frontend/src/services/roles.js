export const LAB_ROLES = ['admin', 'student'];

export function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

export function isStudent(user) {
  return Boolean(user && user.role === 'student');
}

export function canAccessLab(user) {
  return isAdmin(user) || isStudent(user);
}

export function roleLabel(user) {
  if (isAdmin(user)) return 'an administrator';
  if (isStudent(user)) return 'a student';
  return 'a customer';
}

// Username, email, and password rules for registration and account updates.

import { clientError } from '../errors';

/** bcrypt cost factor for stored password hashes. */
export const BCRYPT_ROUNDS = 10;

const MIN_USERNAME_LENGTH = 4;
const MAX_USERNAME_LENGTH = 64;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 4;
/** bcrypt silently ignores input beyond 72 bytes. */
const MAX_PASSWORD_BYTES = 72;

/** Reserved usernames that cannot be used during registration. */
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'about',
  'access',
  'account',
  'accounts',
  'add',
  'address',
  'adm',
  'administration',
  'adult',
  'advertising',
  'affiliate',
  'affiliates',
  'ajax',
  'analytics',
  'android',
  'anon',
  'anonymous',
  'api',
  'app',
  'apps',
  'archive',
  'atom',
  'auth',
  'authentication',
  'avatar',
  'backup',
  'banner',
  'banners',
  'bin',
  'billing',
  'blog',
  'blogs',
  'board',
  'bot',
  'bots',
  'business',
  'chat',
  'cache',
  'cadastro',
  'calendar',
  'campaign',
  'careers',
  'cgi',
  'client',
  'cliente',
  'code',
  'comercial',
  'compare',
  'config',
  'connect',
  'contact',
  'contest',
  'create',
  'compras',
  'css',
  'dashboard',
  'data',
  'db',
  'design',
  'delete',
  'demo',
  'designer',
  'dev',
  'devel',
  'dir',
  'directory',
  'doc',
  'docs',
  'domain',
  'download',
  'downloads',
  'edit',
  'editor',
  'email',
  'ecommerce',
  'forum',
  'forums',
  'faq',
  'favorite',
  'feed',
  'feedback',
  'flog',
  'follow',
  'file',
  'files',
  'free',
  'ftp',
  'gadget',
  'gadgets',
  'games',
  'guest',
  'group',
  'groups',
  'help',
  'home',
  'homepage',
  'host',
  'hosting',
  'hostname',
  'html',
  'http',
  'httpd',
  'https',
  'hpg',
  'info',
  'information',
  'image',
  'img',
  'images',
  'imap',
  'index',
  'invite',
  'intranet',
  'indice',
  'ipad',
  'iphone',
  'irc',
  'java',
  'javascript',
  'job',
  'jobs',
  'js',
  'knowledgebase',
  'log',
  'login',
  'logs',
  'logout',
  'list',
  'lists',
  'mail',
  'mail1',
  'mail2',
  'mail3',
  'mail4',
  'mail5',
  'mailer',
  'mailing',
  'mx',
  'manager',
  'marketing',
  'master',
  'me',
  'media',
  'message',
  'microblog',
  'microblogs',
  'mine',
  'mp3',
  'msg',
  'msn',
  'mysql',
  'messenger',
  'mob',
  'mobile',
  'movie',
  'movies',
  'music',
  'musicas',
  'my',
  'name',
  'named',
  'net',
  'network',
  'new',
  'news',
  'newsletter',
  'nick',
  'nickname',
  'notes',
  'noticias',
  'ns',
  'ns1',
  'ns2',
  'ns3',
  'ns4',
  'old',
  'online',
  'operator',
  'order',
  'orders',
  'page',
  'pager',
  'pages',
  'panel',
  'password',
  'perl',
  'pic',
  'pics',
  'photo',
  'photos',
  'photoalbum',
  'php',
  'plugin',
  'plugins',
  'pop',
  'pop3',
  'post',
  'postmaster',
  'postfix',
  'posts',
  'profile',
  'project',
  'projects',
  'promo',
  'pub',
  'public',
  'python',
  'random',
  'register',
  'registration',
  'root',
  'ruby',
  'rss',
  'sale',
  'sales',
  'sample',
  'samples',
  'script',
  'scripts',
  'secure',
  'send',
  'service',
  'shop',
  'sql',
  'signup',
  'signin',
  'search',
  'security',
  'settings',
  'setting',
  'setup',
  'site',
  'sites',
  'sitemap',
  'smtp',
  'soporte',
  'ssh',
  'stage',
  'staging',
  'start',
  'subscribe',
  'subdomain',
  'suporte',
  'support',
  'stat',
  'static',
  'stats',
  'status',
  'store',
  'stores',
  'system',
  'tablet',
  'tablets',
  'tech',
  'telnet',
  'test',
  'test1',
  'test2',
  'test3',
  'teste',
  'tests',
  'theme',
  'themes',
  'tmp',
  'todo',
  'task',
  'tasks',
  'tools',
  'tv',
  'talk',
  'update',
  'upload',
  'url',
  'user',
  'username',
  'usuario',
  'usage',
  'vendas',
  'video',
  'videos',
  'visitor',
  'win',
  'ww',
  'www',
  'www1',
  'www2',
  'www3',
  'www4',
  'www5',
  'www6',
  'www7',
  'wwww',
  'wws',
  'wwws',
  'web',
  'webmail',
  'website',
  'websites',
  'webmaster',
  'workshop',
  'xxx',
  'xpg',
  'you',
  'yourname',
  'yourusername',
  'yoursite',
  'yourdomain'
]);

/** Throw InvalidUsername unless the username is allowed. */
export function validateUsernameFormat(username: string): void {
  if (typeof username !== 'string' || username.length < MIN_USERNAME_LENGTH) {
    throw clientError(
      'InvalidUsername',
      'Username must be at least 4 characters long'
    );
  }
  if (
    username.length > MAX_USERNAME_LENGTH ||
    !/^[a-zA-Z0-9_.-]+$/.test(username)
  ) {
    throw clientError(
      'InvalidUsername',
      'Username must be 4–64 letters, numbers, periods, underscores, or hyphens'
    );
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    throw clientError(
      'InvalidUsername',
      'This username is invalid - please choose a valid one'
    );
  }
}

/** Throw InvalidEmail unless the address is at cmu.edu or a subdomain. */
export function validateEmailFormat(email: string): void {
  if (
    typeof email !== 'string' ||
    email.length > MAX_EMAIL_LENGTH ||
    /[<>"'\\]/.test(email) ||
    !/^[^\s@]+@([^\s@]+\.)?cmu\.edu$/.test(email)
  ) {
    throw clientError('InvalidEmail', 'Email must be a valid CMU email address');
  }
}

/**
 * Throw WeakPassword or InvalidPassword unless the password has at least four
 * characters including a letter, a digit, and one of $%#@!*&~^-+, and uses
 * only those characters.
 */
export function validatePasswordStrength(password: string): void {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    throw clientError(
      'InvalidPassword',
      'Password must be a string of at most 72 bytes'
    );
  }
  const strengthRules: [boolean, string][] = [
    [
      password.length >= MIN_PASSWORD_LENGTH,
      'Password must be at least 4 characters long'
    ],
    [/[a-zA-Z]/.test(password), 'Password must contain at least one letter'],
    [/[0-9]/.test(password), 'Password must contain at least one number'],
    [
      /[$%#@!*&~^\-+]/.test(password),
      'Password must contain at least one special character'
    ]
  ];
  for (const [passes, message] of strengthRules) {
    if (!passes) throw clientError('WeakPassword', message);
  }
  if (!/^[a-zA-Z0-9$%#@!*&~^\-+]+$/.test(password)) {
    throw clientError('InvalidPassword', 'Password contains invalid characters');
  }
}

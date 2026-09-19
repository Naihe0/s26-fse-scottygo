// Validation helpers for user registration and account management
// Extracted from user.model.ts to reduce module size and coupling (Sigrid Item #7)

import { IAppError } from '../../common/server.responses';

/** Reserved usernames that cannot be used during registration. */
const RESERVED_USERNAMES: string[] = [
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
];

/**
 * Validate username format (length and reserved list).
 * Throws IAppError if username doesn't meet requirements.
 */
export function validateUsernameFormat(username: string): void {
  // Check minimum length
  if (typeof username !== 'string' || username.length < 4) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'InvalidUsername',
      message: 'Username must be at least 4 characters long'
    };
    throw error;
  }

  if (username.length > 64 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
    throw {
      type: 'ClientError',
      name: 'InvalidUsername',
      message:
        'Username must be 4–64 letters, numbers, periods, underscores, or hyphens'
    } as IAppError;
  }

  // Check reserved username list
  if (RESERVED_USERNAMES.includes(username.toLowerCase())) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'InvalidUsername',
      message: 'This username is invalid - please choose a valid one'
    };
    throw error;
  }
}

/**
 * Validate email format (CMU email).
 * Throws IAppError if email doesn't meet requirements.
 */
export function validateEmailFormat(email: string): void {
  // CMU email regex: allows @cmu.edu and @subdomain.cmu.edu (e.g., @andrew.cmu.edu)
  const emailRegex = /^[^\s@]+@([^\s@]+\.)?cmu\.edu$/;
  if (
    typeof email !== 'string' ||
    email.length > 254 ||
    /[<>"'\\]/.test(email) ||
    !emailRegex.test(email)
  ) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'InvalidEmail',
      message: 'Email must be a valid CMU email address'
    };
    throw error;
  }
}

/**
 * Validate password strength according to password rules.
 * Throws IAppError if password doesn't meet requirements.
 */
export function validatePasswordStrength(password: string): void {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    throw {
      type: 'ClientError',
      name: 'InvalidPassword',
      message: 'Password must be a string of at most 72 bytes'
    } as IAppError;
  }
  // Rule 1: At least 4 characters long
  if (password.length < 4) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'WeakPassword',
      message: 'Password must be at least 4 characters long'
    };
    throw error;
  }

  // (Voluntary, not in UC) Rule 2: Must contain at least one letter
  if (!/[a-zA-Z]/.test(password)) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'WeakPassword',
      message: 'Password must contain at least one letter'
    };
    throw error;
  }

  // (Voluntary, not in UC) Rule 3: Must contain at least one number
  if (!/[0-9]/.test(password)) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'WeakPassword',
      message: 'Password must contain at least one number'
    };
    throw error;
  }

  // (Voluntary, not in UC) Rule 4: Must contain at least one special character
  const specialChars = /[$%#@!*&~^\-+]/;
  if (!specialChars.test(password)) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'WeakPassword',
      message: 'Password must contain at least one special character'
    };
    throw error;
  }

  // (Voluntary, not in UC) Rule 5: Cannot contain any characters other than letters, numbers,
  //                                and allowed special chars
  const validChars = /^[a-zA-Z0-9$%#@!*&~^\-+]+$/;
  if (!validChars.test(password)) {
    const error: IAppError = {
      type: 'ClientError',
      name: 'InvalidPassword',
      message: 'Password contains invalid characters'
    };
    throw error;
  }
}

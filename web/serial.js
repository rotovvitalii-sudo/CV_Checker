// Общая очередь для тяжёлых скриптов: check_cv.py и рендер запускают LibreOffice,
// а два soffice одновременно конфликтуют за профиль пользователя.
let chain = Promise.resolve();
module.exports = function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

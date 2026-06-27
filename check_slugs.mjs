const heading = "Tuṣita heaven";
const slug1 = heading
  .toLowerCase()
  .replace(/[\s/]+/g, '-')
  .replace(/[^\w\-]/g, c => encodeURIComponent(c));
  
const slug2 = heading
  .toLowerCase()
  .replace(/[\s/]+/g, '-');

console.log('With encode:', slug1);
console.log('Without encode:', slug2);
console.log('Link would be: ####' + slug2);

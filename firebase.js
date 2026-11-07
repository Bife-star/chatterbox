// Connects the site to your Firebase project.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import * as A from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import * as F from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyD35Y4kC41GETNKpmfkK0pNU5EzfXF-YLU",
  authDomain: "chatterbox-79689.firebaseapp.com",
  projectId: "chatterbox-79689",
  appId: "1:1061833852835:web:7e85cc8aa895937ea5bc16"
});

export const auth = A.getAuth(app);
export const db = F.getFirestore(app);
export { A, F };   // A = accounts tools, F = database tools

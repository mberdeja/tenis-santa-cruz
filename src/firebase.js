import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAWDmKePVrlUwhAv1fzaP1wDB6Iwc8GLqw",
  authDomain: "tenis-de-mesa-42430.firebaseapp.com",
  projectId: "tenis-de-mesa-42430",
  storageBucket: "tenis-de-mesa-42430.firebasestorage.app",
  messagingSenderId: "405689823091",
  appId: "1:405689823091:web:ec3f5fee47e1aa391c1f06"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

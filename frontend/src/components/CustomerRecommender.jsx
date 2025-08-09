// src/components/CustomerRecommender.jsx
import React, { useEffect, useState } from "react";
import styles from "./CustomerRecommender.module.css";
import { getGeminiResponse } from "../gemini";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";
import { stripHtml } from "../utils/stripHtml";
import { smartFallbackFilter } from "../utils/fallbackProductMatch";


const queryParams = new URLSearchParams(window.location.search);
const storeId = queryParams.get("storeId") || "iamnaturalstore";

function CustomerRecommender() {
  const [concern, setConcern] = useState("");
  const [commonConcerns, setCommonConcerns] = useState([]);
  const [responseText, setResponseText] = useState("");
  const [storeSettings, setStoreSettings] = useState(null);
  const [plan, setPlan] = useState("free");
  const [storeProducts, setStoreProducts] = useState([]);
  const [matchedProducts, setMatchedProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);

  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const settingsRef = doc(db, "storeSettings", storeId);
        const settingsSnap = await getDoc(settingsRef);
        if (settingsSnap.exists()) {
          const data = settingsSnap.data();
          setStoreSettings(data);
          setPlan(data.plan || "free");
        } else {
          console.warn("⚠️ storeSettings doc not found");
        }

        const productsRef = collection(db, "products", storeId, "items");
        const productSnap = await getDocs(productsRef);
        const productList = productSnap.docs.map((doc) => doc.data());
        setStoreProducts(productList);
        console.log("✅ Loaded products:", productList.length);

        const concernsRef = collection(db, "commonConcerns", storeId, "items");
        const concernsSnap = await getDocs(concernsRef);
        const concernsList = concernsSnap.docs.map((doc) => doc.data().text);
        setCommonConcerns(concernsList);
      } catch (err) {
        console.error("❌ Failed to load initial data:", err);
      }
    };

    loadInitialData();
  }, []);

  const handleRecommend = async () => {
    if (!concern.trim()) return;
    setLoading(true);
    setResponseText("");
    setMatchedProducts([]);

    const normalizedConcern = concern.toLowerCase().trim();
    console.log("🧭 Concern:", normalizedConcern);

    // Step 1: Check if concern is already mapped
    const mappingRef = doc(db, "mappings", storeId, "concernToProducts", normalizedConcern);
    const mappingSnap = await getDoc(mappingRef);
    if (mappingSnap.exists()) {
      const data = mappingSnap.data();
      setResponseText(data.explanation || "Here's what we recommend.");
      const matched = storeProducts.filter((p) =>
        data.productIds.includes((p.id || p.name || "").toLowerCase().trim())
      );
      setMatchedProducts(matched);
      setLoading(false);
      return;
    }

    // Step 2: Use Gemini (if Pro or Pro+)
    if (plan === "pro" || plan === "pro+") {
      const fuzzyKeywords = [
        ...normalizedConcern.split(" "),
        normalizedConcern,
        "acne", "blemish", "dry", "eczema", "redness", "wrinkles", "hydration"
      ];

      const relevantProducts = storeProducts.filter((p) => {
        const tags = (p.tags || []).map((t) => t.toLowerCase());
        const desc = (p.description || "").toLowerCase();
        const keywords = (p.keywords || []).map((k) => k.toLowerCase());
        const ingredients = (p.ingredients || []).map((i) => i.toLowerCase());
        const type = (p.productType || "").toLowerCase();

        return fuzzyKeywords.some((kw) =>
          tags.includes(kw) ||
          keywords.includes(kw) ||
          ingredients.includes(kw) ||
          desc.includes(kw) ||
          type.includes(kw)
        );
      });

      const trimmedProducts = relevantProducts.slice(0, 200);

      const promptInput = {
        concern,
        category: storeSettings?.category || "Beauty",
        tone: storeSettings?.tone || "Helpful, expert, friendly",
        products: trimmedProducts.map((p) => ({
          id: p.id || p.name,
          name: p.name,
          description: p.description || "",
          tags: p.tags || [],
          productType: p.productType || "",
          category: p.category || "",
          keywords: p.keywords || [],
          ingredients: p.ingredients || [],
        })),
      };

      try {
  const aiResponse = await getGeminiResponse(promptInput);
  setResponseText(aiResponse.explanation || "Here are your recommended products.");
  const productIds = aiResponse.productIds || [];

  const matched = storeProducts.filter((p) =>
    productIds.includes((p.id || p.name || "").toLowerCase().trim())
  );
  setMatchedProducts(matched);

  // ✅ Save this new mapping to Firestore
  await setDoc(
    doc(db, "mappings", storeId, "concernToProducts", normalizedConcern),
    {
      concern: normalizedConcern,
      productIds,
      explanation: aiResponse.explanation || "",
      createdAt: Date.now(),
    }
  );

  // ✅ Log conversation
  const logRef = collection(db, "conversations", storeId, "logs");
  await addDoc(logRef, {
    concern,
    response: aiResponse.explanation,
    productIds,
    timestamp: serverTimestamp(),
  });
} catch (err) {
  console.error("❌ Gemini AI Error:", err.message || err);
  setResponseText("⚠️ Sorry, something went wrong with our smart suggestions.");
}


      setLoading(false);
      return;
    }

    // Step 3: Free Plan Fallback – smart prioritized matching
const fallbackMatches = smartFallbackFilter(storeProducts, concern, category);

setMatchedProducts(fallbackMatches);

setResponseText(
  fallbackMatches.length > 0
    ? "I couldn’t find an exact match for your request, but here are some of our most popular face oils that may suit your needs."
    : "⚠️ We couldn’t find any relevant products, but we’re working on it!"
);

setLoading(false);

  };

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>🛍️ Refina: Your Personal AI Shopping Concierge</h1>
      <p className={styles.subtext}>What do you need help with?</p>

      {commonConcerns.length > 0 && (
        <div className={styles.concernButtons}>
          {commonConcerns.map((item) => (
            <button key={item} onClick={() => setConcern(item)}>
              {item}
            </button>
          ))}
        </div>
      )}

      <textarea
        className={styles.textarea}
        value={concern}
        onChange={(e) => setConcern(e.target.value)}
        placeholder="Type your concern here..."
      />

      <button className={styles.askButton} onClick={handleRecommend} disabled={loading}>
        {loading ? "Thinking..." : "Ask"}
      </button>

      {responseText && (
        <div className={styles.responseBox}>
          <h2>💡 Our Recommendation</h2>
          <p>{responseText}</p>
        </div>
      )}

      {matchedProducts.length > 0 && (
        <>
          <div className={styles.responseBox}>
            <h2>🛍️ Product Matches</h2>
            <p>Here are some product matches based on your concern!</p>
          </div>
          <div className={styles.grid}>
            {matchedProducts.map((product) => (
              <div
                key={product.id || product.name}
                className={styles.card}
                onClick={() => setSelectedProduct(product)}
              >
                <img src={product.image} alt={product.name} className={styles.image} />
                <h3 className={styles.productTitle}>{product.name}</h3>
                <p className={styles.productDescription}>
                  {stripHtml(product.description || "").slice(0, 100)}...
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      {selectedProduct && (
        <div className={styles.modalOverlay} onClick={() => setSelectedProduct(null)}>
          <div className={styles.modal}>
            <h2>{selectedProduct.name}</h2>
            <img src={selectedProduct.image} alt={selectedProduct.name} />
            <p>{selectedProduct.description}</p>
            <a
              href={selectedProduct.link || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.buyButton}
            >
              Buy Now
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default CustomerRecommender;

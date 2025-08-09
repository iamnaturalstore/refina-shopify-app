// frontend/src/main.jsx
import React, { useState, useEffect } from "react"
import ReactDOM from "react-dom/client"
import App from "./app.jsx"

import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth"
import { auth } from "./firebase" // make sure this exports the initialized auth object

function Root() {
  const [authReady, setAuthReady] = useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        console.log("✅ Firebase: Anonymous auth ready")
        setAuthReady(true)
      } else {
        signInAnonymously(auth)
          .then(() => console.log("✅ Firebase: Signed in anonymously"))
          .catch((err) => console.error("❌ Firebase anonymous auth failed", err))
      }
    })
    return () => unsubscribe()
  }, [])

  if (!authReady) return <div>Loading Refina...</div>

  return (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />)

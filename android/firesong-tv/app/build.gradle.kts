import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Host-specific build values come from -P<name>=<value> or from the
// git-ignored firesong.local.properties next to settings.gradle.kts (see
// firesong.local.properties.example). Nothing LAN-specific is committed.
val localProps = Properties().apply {
    val f = rootProject.file("firesong.local.properties")
    if (f.isFile) f.inputStream().use { load(it) }
}

fun fsProp(name: String): String? =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }
        ?: localProps.getProperty(name)?.takeIf { it.isNotBlank() }

fun javaString(s: String): String {
    require(s.none { it == '"' || it == '\\' || it == '\n' }) { "build value must not contain quotes, backslashes or newlines: $s" }
    return "\"$s\""
}

// Debug: the TV page over `adb reverse tcp:64448 tcp:64448` (a secure context
// without certificates). Release: no default; set firesong.tvUrl or configure
// the installed app through the .Configure alias.
val debugTvUrl = fsProp("firesong.debugTvUrl") ?: "http://localhost:64448/?tv=1"
val releaseTvUrl = fsProp("firesong.tvUrl") ?: ""
// Comma-separated leaf pins for the onReceivedSslError fallback:
// 64 hex chars (certificate SHA-256) or sha256/<base64> (SPKI).
val leafPins = fsProp("firesong.leafPins") ?: ""

android {
    namespace = "org.firesong.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.firesong.tv"
        minSdk = 28 // Fire OS 7 = Android 9
        targetSdk = 28 // Fire OS 7 (AFTGAZL); see lint block
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "LEAF_PINS", javaString(leafPins))
    }

    ndkVersion = "27.3.13750724"

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_TV_URL", javaString(debugTvUrl))
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "true")
        }
        release {
            isMinifyEnabled = false
            buildConfigField("String", "DEFAULT_TV_URL", javaString(releaseTvUrl))
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "false")
            // Sideloaded only (as FirePlay): sign with the debug key so `adb
            // install -r` can replace a debug build.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    // targetSdk 28 is deliberate for Fire OS 7; the Play API-level checks do not apply.
    lint {
        disable += setOf("ExpiredTargetSdkVersion", "OldTargetApi")
        abortOnError = true
        checkReleaseBuilds = false
    }
}

// Optional: bundle the real LAN CA root without committing it:
//   ./gradlew assembleRelease -Pfiresong.lanCa=/path/to/caddy-root.crt
// The file replaces res/raw/firesong_lan_ca.pem in every variant.
abstract class FiresongLanCaTask : DefaultTask() {
    @get:InputFile
    abstract val caFile: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val text = caFile.get().asFile.readText()
        require(text.contains("-----BEGIN CERTIFICATE-----")) { "firesong.lanCa must be a PEM certificate" }
        val raw = outputDir.get().dir("raw").asFile
        raw.deleteRecursively()
        raw.mkdirs()
        File(raw, "firesong_lan_ca.pem").writeText(text)
    }
}

fsProp("firesong.lanCa")?.let { path ->
    val ca = file(path)
    require(ca.isFile) { "firesong.lanCa=$path is not a file" }
    val task = tasks.register<FiresongLanCaTask>("firesongLanCa") {
        caFile.set(ca)
        outputDir.set(layout.buildDirectory.dir("generated/firesong/lanCaRes"))
    }
    androidComponents {
        onVariants { variant ->
            variant.sources.res?.addGeneratedSourceDirectory(task, FiresongLanCaTask::outputDir)
        }
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

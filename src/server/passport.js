import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as TwitterStrategy } from "passport-twitter";
import { OAuth2Strategy as GoogleStrategy } from "passport-google-oauth";

import db from "./db.js";
import keysConf from "../../config/passportKeys.json";
import config from "../../config/config.json";
import User from "./controllers/user.js";
import to from "await-to-js";

passport.serializeUser((user, done) => done(null, user.data._id));

passport.deserializeUser(async (id, done) => {
  let [err, user] = await to(db.User.findById(id).exec());
  if (err) {
    console.error(err);
  }
  user = new User(user);
  return done(err, user);
});

/*
 * Sign in using Email and Password.
 */
passport.use(
  new LocalStrategy(
    {
      usernameField: "email"
    },
    async (email, password, done) => {
      let [error, user] = await to(
        db.User.findOne({
          email: email.toLowerCase()
        }).exec()
      );

      if (error) {
        return done(error);
      }

      if (!user) {
        return done(`Email ${email} not found.`);
      }

      user = new User(user);
      let [err, matched] = await to(user.verifyPassword(password));

      if (err) {
        return done(err);
      }

      if (matched) {
        return done(null, user);
      }

      return done("Invalid credentials.");
    }
  )
);

// TWITTER
passport.use(
  new TwitterStrategy(
    {
      consumerKey: keysConf.TWITTER_KEY,
      consumerSecret: keysConf.TWITTER_SECRET,
      callbackURL: `${config.url || ""}/auth/twitter/callback`,
      passReqToCallback: true
    },
    async (req, accessToken, tokenSecret, profile, done) => {
      // checking for linked accounts
      let [error, existingUser] = await to(
        db.User.findOne({
          twitter: profile.id
        }).exec()
      );

      if (error) {
        return done(error);
      }

      if (existingUser) {
        if (req.user) {
          req.session.message = {
            msg: "This Twitter account is already linked.",
            error: true
          };

          return done(null, false);
        }
        return done(null, new User(existingUser));
      }

      if (req.user) {
        // linking Twitter with existing logged in account
        let user = new User(req.user.data);
        user.data.twitter = profile.id;
        user.data.tokens.push({
          kind: "twitter",
          accessToken,
          tokenSecret
        });
        // profile info
        user.data.profile.name = user.data.profile.name || profile.displayName;
        user.data.profile.location =
          user.data.profile.location || profile._json.location;
        user.data.profile.picture =
          user.data.profile.picture || profile._json.profile_image_url_https;

        // save user
        let [linkError, linkedUser] = await to(user.saveUser());

        if (linkError) {
          return done(linkError);
        }

        let [err] = await to(_promisifiedPassportLogin(req, linkedUser));

        if (err) {
          req.session.message = {
            msg: "Internal server error.",
            error: true
          };

          return done(null, false);
        }

        // Twitter linked successfully
        req.session.message = {
          msg: "Twitter successfully linked!",
          error: false
        };
        return done(null, user);
      }

      // create new user
      let user = new User();
      // Twitter will not provide an email address, so we save the Twitter handle, which is unique,
      // and produce a fake 'email':
      user.data.email = `${profile.username}@twitter.com`;
      user._meta.noPassword = true;
      user.data.twitter = profile.id;
      user.data.tokens.push({
        kind: "twitter",
        accessToken,
        tokenSecret
      });
      user.data.profile.name = profile.displayName;
      user.data.profile.location = profile._json.location;
      user.data.profile.picture = profile._json.profile_image_url_https;

      let [creationError, createdUser] = await to(user.saveUser());

      if (creationError) {
        req.session.message = {
          msg: "Internal server error.",
          error: true
        };

        return done(null, false);
      }

      // created a new account via Twitter
      req.session.message = {
        msg: "Created a new account via Twitter!",
        error: false
      };
      return done(null, createdUser);
    }
  )
);

// GOOGLE
passport.use(
  new GoogleStrategy(
    {
      clientID: keysConf.GOOGLE_ID,
      clientSecret: keysConf.GOOGLE_SECRET,
      callbackURL: `${config.url || ""}/auth/google/callback`,
      passReqToCallback: true
    },
    async (req, accessToken, refreshToken, profile, done) => {
      // checking for linked accounts
      let [error, existingUser] = await to(
        db.User.findOne({
          google: profile.id
        }).exec()
      );

      if (error) {
        return done(error);
      }

      if (existingUser) {
        if (req.user) {
          req.session.message = {
            msg: "This Google account is already linked.",
            error: true
          };

          return done(null, false);
        }

        return done(null, new User(existingUser));
      }

      if (req.user) {
        // linking Google with existing logged in account
        let user = new User(req.user.data);
        user.data.google = profile.id;
        user.data.tokens.push({
          kind: "google",
          accessToken
        });

        user.data.profile.name = user.data.profile.name || profile.displayName;
        user.data.profile.gender =
          user.data.profile.gender || profile._json.gender;
        user.data.profile.picture =
          user.data.profile.picture || profile._json.picture;

        // save user
        let [linkError, linkedUser] = await to(user.saveUser());

        if (linkError) {
          return done(linkError);
        }

        let [err] = await to(_promisifiedPassportLogin(req, linkedUser));

        if (err) {
          req.session.message = {
            msg: "Internal server error.",
            error: true
          };

          return done(null, false);
        }

        // Google linked successfully
        req.session.message = {
          msg: "Google successfully linked!",
          error: false
        };
        return done(null, user);
      }

      // create new user
      let user = new User();
      user._meta.noPassword = true;
      user.data.email = profile.emails[0].value;
      user.data.google = profile.id;
      user.data.tokens.push({
        kind: "google",
        accessToken
      });

      user.data.profile.name = profile.displayName;
      user.data.profile.gender = profile._json.gender;
      user.data.profile.picture = profile._json.picture;
      let [creationError, createdUser] = await to(user.saveUser());

      if (creationError) {
        if (creationError.code == 11000) {
          req.session.message = {
            msg: "This email account is already in use!",
            error: true
          };

          return done(null, false);
        } else {
          req.session.message = {
            msg: "Internal server error.",
            error: true
          };

          return done(null, false);
        }
      }

      // created a new account via Google
      req.session.message = {
        msg: "Created a new account via Google!",
        error: false
      };
      return done(null, new User(createdUser));
    }
  )
);

export const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect("/login");
};

export const isAuthorized = (req, res, next) => {
  const provider = req.path.split("/").slice(-1)[0];
  const token = req.user.data.tokens.find(token => token.kind === provider);
  if (token) {
    return next();
  }

  res.redirect(`/auth/${provider}`);
};

export const _promisifiedPassportAuthentication = (req, res) => {
  return new Promise((resolve, reject) => {
    passport.authenticate("local", (err, user, info) => {
      if (err) {
        return reject(err);
      }
      return resolve(user);
    })(req, res);
  });
};

export const _promisifiedPassportLogin = (req, user) => {
  return new Promise((resolve, reject) => {
    req.logIn(user, (err, user, info) => {
      if (err) {
        return reject(err);
      }
      return resolve(user);
    });
  });
};

export const _promisifiedPassportLogout = req => {
  return new Promise((resolve, reject) => {
    req.logout();
    req.session.destroy(err => {
      if (err) {
        return reject(err);
      }
      return resolve();
    });
  });
};

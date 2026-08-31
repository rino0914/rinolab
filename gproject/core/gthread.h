#include <iostream>
#include <cstring>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <ctime>
#include "gref.h"
#include <string>

using namespace std;

class Gthread : public Gref{
    private:
    bool used;
    bool enable;
    string name;

    public:
    Gthread() :used(false), enable(false), name("undefined") {}
    Gthread(bool _used, bool _enable, string _name) :used(_used), enable(_enable), name(_name) {}

    void setUsed(int _used);
    void setEnable(bool _enable);
    void setName(string _name);

    bool getUsed();
    bool getEnable();
    string getName();

    virtual bool initConfig();
    virtual bool init();
    virtual bool onThreadLoop();
    bool stopThread();
    
};